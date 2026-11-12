#!/usr/bin/env node
/**
 * Live SRU smoke script for the dev CLI (src/cli.js).
 *
 * What it smokes, in one command:
 *   1. Fetch one real record from the SRU endpoint (read-only searchRetrieve)
 *   2. Convert the MARCXML to the CLI's internal record JSON
 *   3. LIVE run:   node src/cli.js <rec> --sru-url <url> --merge on --record <capture>
 *   4. REPLAY run: same CLI, --replay <capture> instead of --record (offline)
 *   5. Assert: live exit 0, capture has entries, replay exit 0, and the
 *      "Decision:" line of live and replay is byte-identical (record -> replay
 *      traces must match)
 *
 * READ-ONLY: the script only issues SRU searchRetrieve queries. It never
 * performs any write operation; the endpoint itself is read-only too.
 *
 * The SRU endpoint comes from the SRU_URL environment variable (the project's
 * standard env var, see README and src/config.js); override with --sru-url.
 *
 * Examples:
 *   SRU_URL=<url> node scripts/live-smoke.mjs
 *   node scripts/live-smoke.mjs --sru-url <url> --query title=x
 *   SRU_URL=<url> node scripts/live-smoke.mjs --strip-cats-lows --keep-files
 *
 * Options:
 *   --sru-url <url>        SRU endpoint (default: the SRU_URL environment variable)
 *   --query <q>            CQL query for the record fetch (default: title=aalto)
 *   --match-packages <l>   Match packages for the CLI runs (default: IDS)
 *   --strip-cats-lows      Extra info-only probe: run the live probe again with
 *                          the CAT and LOW fields removed from the record JSON
 *   --keep-files           Keep the temp record/capture files and print their paths
 *
 * Exit codes: 0 = all smoke assertions passed, 1 = any assertion failed or an
 * error occurred.
 */
import {spawn} from 'node:child_process';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {MarcRecord} from '@natlibfi/marc-record';
import {MARCXML} from '@natlibfi/marc-record-serializers';

const DEFAULT_QUERY = 'title=aalto';
const DEFAULT_MATCH_PACKAGES = 'IDS';

class SmokeError extends Error { }

function fail(message) {
  throw new SmokeError(message);
}

function parseArgs(argv) {
  const args = {
    sruUrl: process.env.SRU_URL ?? null,
    query: DEFAULT_QUERY,
    matchPackages: DEFAULT_MATCH_PACKAGES,
    stripCatsLows: false,
    keepFiles: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i += 1];
      if (value === undefined) {
        fail(`Missing value for ${arg}`);
      }
      return value;
    };

    if (arg === '--sru-url') {
      args.sruUrl = next();
    } else if (arg === '--query') {
      args.query = next();
    } else if (arg === '--match-packages') {
      args.matchPackages = next();
    } else if (arg === '--strip-cats-lows') {
      args.stripCatsLows = true;
    } else if (arg === '--keep-files') {
      args.keepFiles = true;
    } else if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else {
      fail(`Unknown option: ${arg} (see --help)`);
    }
  }
  return args;
}

// Step 1: fetch one real record with a read-only searchRetrieve query
async function fetchRecord(sruUrl, query) {
  const url = `${sruUrl}?version=1.1&operation=searchRetrieve&query=${encodeURIComponent(query)}&maximumRecords=1`;
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    fail(`SRU fetch failed: ${err.message}`);
  }
  if (!response.ok) {
    fail(`SRU fetch failed: HTTP ${response.status} for ${url}`);
  }
  const body = await response.text();

  const countMatch = /<\w*:?numberOfRecords[^>]*>(\d+)</u.exec(body);
  const recordCount = countMatch ? Number(countMatch[1]) : NaN;
  if (!Number.isInteger(recordCount) || recordCount === 0) {
    fail(`SRU query '${query}' returned 0 records against ${sruUrl} — the smoke script needs one real record to probe; try a different --query`);
  }
  const recordMatch = /<record[ >][\s\S]*?<\/record>/u.exec(body);
  if (!recordMatch) {
    fail('SRU response has records but no <record> element could be extracted (unexpected MARCXML shape)');
  }
  return {recordCount, recordXml: recordMatch[0]};
}

// Step 2: MARCXML -> internal record JSON. subfieldValues: false keeps
// valueless subfields (e.g. CAT $b) in the record — stripping them changes the
// modification-history check and can cause a spurious CAT 409 on replay
function toRecordJson(recordXml) {
  return MARCXML.from(recordXml, {subfieldValues: false}).then(async parsed => {
    const record = new MarcRecord(parsed.toObject(), {subfieldValues: false});
    return {recordJson: record.toObject(), valuelessInJson: countValuelessSubfields(record.toObject())};
  }).catch(err => fail(`MARCXML conversion failed: ${err.message}`));
}

function countValuelessSubfields(recordJson) {
  let count = 0;
  for (const field of recordJson.fields ?? []) {
    for (const subfield of field.subfields ?? []) {
      if (subfield.value === undefined) {
        count += 1;
      }
    }
  }
  return count;
}

// Strip CAT and LOW fields for the extra info-only probe
function stripCatsLows(recordJson) {
  return {
    ...recordJson,
    fields: recordJson.fields.filter(field => field.tag !== 'CAT' && field.tag !== 'LOW')
  };
}

// Steps 4/5: spawn the CLI with the given args and capture exit code + output
function runCli(cliPath, cliArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...cliArgs], {cwd: dirname(dirname(fileURLToPath(import.meta.url)))});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {stdout += chunk;});
    child.stderr.on('data', chunk => {stderr += chunk;});
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

function decisionLine(stdout) {
  const line = stdout.split('\n').find(l => l.startsWith('Decision: '));
  return line ?? null;
}

async function probeLiveReplay({cliPath, workDir, label, sruUrl, matchPackages, recordFile}) {
  const captureFile = join(workDir, `${label}.capture.json`);
  const baseArgs = [recordFile, '--sru-url', sruUrl, '--match-packages', matchPackages, '--merge', 'on'];
  const liveArgs = [...baseArgs, '--record', captureFile];
  const replayArgs = [...baseArgs, '--replay', captureFile];

  const live = await runCli(cliPath, liveArgs);
  const replay = await runCli(cliPath, replayArgs);
  return {live, replay, captureFile};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: SRU_URL=<url> node scripts/live-smoke.mjs [options]

The SRU endpoint is taken from --sru-url, or from the SRU_URL environment
variable when the flag is not given.

Options:
  --sru-url <url>        SRU endpoint (default: the SRU_URL environment variable)
  --query <q>            CQL query for the record fetch (default: ${DEFAULT_QUERY})
  --match-packages <l>   Match packages for the CLI runs (default: ${DEFAULT_MATCH_PACKAGES})
  --strip-cats-lows      Extra info-only probe with CAT and LOW fields removed
  --keep-files           Keep the temp record/capture files
  -h, --help             Show this help`);
    return 0;
  }
  if (!args.sruUrl) {
    fail('No SRU endpoint: set the SRU_URL environment variable or pass --sru-url <url>');
  }

  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const cliPath = join(projectRoot, 'src', 'cli.js');
  const workDir = join(tmpdir(), `live-smoke-${process.pid}`);
  mkdirSync(workDir, {recursive: true});

  const failures = [];
  const check = (name, ok, detail = '') => {
    if (!ok) {
      failures.push(`${name}${detail ? `: ${detail}` : ''}`);
    }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
  };

  try {
    // 1. fetch one real record (read-only SRU)
    const {recordCount, recordXml} = await fetchRecord(args.sruUrl, args.query);
    console.log(`fetched 1 of ${recordCount} records for query '${args.query}' from ${args.sruUrl}`);

    // 2. convert to the CLI's internal record JSON (valueless subfields preserved)
    const {recordJson, valuelessInJson} = await toRecordJson(recordXml);
    const valuelessInXml = (recordXml.match(/<subfield code="[^"]*\/>/gu) ?? []).length;
    if (valuelessInJson < valuelessInXml) {
      console.log(`WARN  ${valuelessInXml} valueless subfields in the MARCXML but only ${valuelessInJson} in the converted JSON (expected: kept via subfieldValues: false)`);
    }
    const recordFile = join(workDir, 'record.json');
    writeFileSync(recordFile, `${JSON.stringify(recordJson, null, 2)}\n`);

    // 3+4. live run (--record capture) and replay run (--replay capture)
    const {live, replay, captureFile} = await probeLiveReplay({cliPath, workDir, label: 'main', sruUrl: args.sruUrl, matchPackages: args.matchPackages, recordFile});
    console.log(live.stdout);
    console.log(replay.stdout);

    // 5. assertions
    check('live run exit 0', live.code === 0, `exit ${live.code}${live.code !== 0 ? ` stderr: ${live.stderr.trim()}` : ''}`);
    let captureEntries = 0;
    let captureOk = false;
    try {
      captureEntries = readFileSync(captureFile, 'utf8') ? JSON.parse(readFileSync(captureFile, 'utf8')).entries.length : 0;
      captureOk = true;
    } catch {
      captureEntries = 0;
    }
    check('capture file has entries', captureOk && captureEntries >= 1, `entries=${captureEntries} (expected >= 1)`);
    if (captureOk && captureEntries >= 1 && captureEntries < 2) {
      console.log('WARN  capture has only 1 entry (expected 2 for a self-match with --merge on: matcher search + rec.id lookup; 1 is possible when the record matches nothing)');
    }
    check('replay run exit 0', replay.code === 0, `exit ${replay.code}${replay.code !== 0 ? ` stderr: ${replay.stderr.trim()}` : ''}`);
    const liveDecision = decisionLine(live.stdout);
    const replayDecision = decisionLine(replay.stdout);
    check('Decision lines byte-identical (live vs replay)', liveDecision !== null && liveDecision === replayDecision,
      liveDecision !== null ? `${liveDecision} / ${replayDecision}` : 'no Decision line found in live output');

    // 6. optional info-only probe: CAT/LOW fields removed (shows CAT-409 avoidance)
    if (args.stripCatsLows) {
      const strippedFile = join(workDir, 'record-no-cats-lows.json');
      writeFileSync(strippedFile, `${JSON.stringify(stripCatsLows(recordJson), null, 2)}\n`);
      const {live: strippedLive} = await probeLiveReplay({cliPath, workDir, label: 'no-cats-lows', sruUrl: args.sruUrl, matchPackages: args.matchPackages, recordFile: strippedFile});
      console.log(strippedLive.stdout);
      const strippedDecision = decisionLine(strippedLive.stdout);
      console.log(`INFO  probe without CAT/LOW fields: exit ${strippedLive.code}, ${strippedDecision ?? 'no Decision line'}`);
      // info only: not asserted, only reported
    }
  } finally {
    if (args.keepFiles) {
      console.log(`temp files kept in ${workDir}`);
    } else {
      rmSync(workDir, {recursive: true, force: true});
    }
  }

  // 7. summary
  console.log('');
  if (failures.length === 0) {
    console.log('PASS: live smoke passed (live and replay decisions match)');
    return 0;
  }
  console.log(`FAIL: live smoke failed with ${failures.length} assertion(s):`);
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
  return 1;
}

main().then(code => process.exitCode = code).catch(err => {
  console.error(`live-smoke error: ${err.message}`);
  process.exitCode = 1;
});
