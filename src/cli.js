#!/usr/bin/env node
/**
 * Validator dev CLI: run the CREATE / UPDATE validation decision pipeline
 * offline against a read-only SRU endpoint and print the decision trace
 * (dry-run import decisions: "what would the production pipeline decide for
 * this record?").
 *
 * Usage:
 *   node src/cli.js record.json --sru-url https://sru.api.melinda.kansalliskirjasto.fi/bib/prv
 *   node src/cli.js record.json --sru-url ... --merge on --match-failures-as-new 1 -o trace.json
 *   node src/cli.js record.json --stub-results fixture.json   (offline: the fixture serves SRU)
 *
 * - Input: one record JSON in internal MarcRecord format ({leader, fields})
 *   (same shape as used in validations.test.js / the importer's processLoad).
 * - Live dependency: read-only SRU ONLY (candidate searches + rec.id
 *   getRecord of the target record on the merge and UPDATE paths). No Mongo,
 *   no AMQP, no Aleph writes. SRU traffic can be replaced by a fixture file
 *   (--stub-results / --replay, fully offline) or captured from a live run
 *   (--record) via a fetch-level interceptor.
 * - Exit codes: 0 when the pipeline reaches a decision (create / merge / update /
 *   skip / 409 conflict / validation failed / would-skip-validation), 1 on CLI
 *   usage errors or pipeline errors.
 *
 * Note: src/config.js reads env vars at module load. The CLI applies its
 * options to process.env BEFORE importing config.js. The config import is
 * keyed by the resolved record type, so within one process each record type
 * gets its config from the environment as set by the first runCli() call
 * that used it.
 */
/* eslint-disable no-console */
import {readFileSync, writeFileSync, realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {isValidAlephId, getRecordMetadata} from './utils.js';

export const USAGE = `Usage: melinda-validator-cli <record.json> [options]

Runs the validator's decision pipeline offline against a read-only SRU
endpoint and prints the decision trace. The CREATE operation runs the match
chain -> matchValidation -> match selector -> merge / update validations; the
UPDATE operation runs the update validations against the target record.

Options:
  --sru-url <url>                  SRU endpoint (or env SRU_URL). Required for live and
                                   --record runs; not needed for --stub-results / --replay
                                   (no wire traffic), a would-skip run (all entry gates off)
                                   or an autname CREATE run (validation probe, no SRU traffic)
  --record-type bib|autname        Record type to probe (default: env RECORD_TYPE, else bib).
                                   autname has no match stage: --merge on, --unique on and
                                   the match flags (--match-packages / --match-selector-rules /
                                   --match-failures-as-new) are rejected for it. A CREATE run
                                   is a validation probe needing no SRU traffic; an UPDATE
                                   probe works against an autname SRU endpoint via --sru-url
  --operation CREATE|UPDATE        Operation to probe (default: CREATE)
  --target-id <id>                 Target record id, required with --operation UPDATE
                                   (9-digit Aleph id; must match the record's 001 if present)
  --match-packages <a,b,c>         Match packages to run
                                   (default: env VALIDATOR_MATCH_PACKAGES or IDS,STANDARD_IDS,CONTENTALT)
  --merge on|off                   Run the merge path when matches are found (default: off)
  --match-failures-as-new 0|1      Treat matchValidation failures as new record
                                   (default: env MATCH_FAILURES_AS_NEW or 0)
  --match-selector-rules <a,b,c>   Match selector rules, in priority order
                                   (default: env MATCH_SELECTOR_RULES or all seven rules)
  --unique on|off                  Enable the unique (match) pipeline entry setting (default: on)
  --validate on|off                Enable the validate pipeline entry setting (default: off)
  --stub-results <file.json>       Serve SRU responses from a fixture file instead of live
                                   traffic (fully offline; a fixture miss is a loud error)
  --replay <file.json>             Replay a capture file from a --record run (fully offline)
  --record <file.json>             Run against live SRU and capture the SRU traffic to a
                                   replay file
  -o, --output <file>              Write the full trace as JSON to <file>
  -h, --help                       Show this help

Record input: one record JSON in internal MarcRecord format ({leader, fields}).
Record type: --record-type bib|autname (default: env RECORD_TYPE, else bib); see the
flag description for the autname restrictions. Read-only SRU traffic only (no Mongo / AMQP / Aleph).
SRU source: --stub-results / --replay / --record are mutually exclusive. Fixture and
capture files share one format: {entries: [{url, status, body}]} keyed by the exact SRU
request URL (built from the SRU endpoint, or a placeholder endpoint when none is given).
Production entry gate: the pipeline runs when any of merge / unique / validate is on;
with all three off the CLI reports WOULD_SKIP_VALIDATION without running the pipeline.
Exit codes: 0 = decision reached (create / merge / update / skip / 409 conflict / validation failed / would-skip-validation), 1 = error.`;

class CliError extends Error { }

export function parseArgs(argv) {
  const args = {
    recordFile: undefined,
    sruUrl: undefined,
    recordType: undefined,
    matchPackages: undefined,
    operation: 'CREATE',
    targetId: undefined,
    merge: 'off',
    unique: 'on',
    validate: 'off',
    matchFailuresAsNew: undefined,
    matchSelectorRules: undefined,
    output: undefined,
    stubResults: undefined,
    replay: undefined,
    record: undefined,
    help: false
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    const next = () => {
      const value = argv[i += 1];
      if (value === undefined) {
        throw new CliError(`Missing value for ${arg}`);
      }
      return value;
    };

    if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '-o' || arg === '--output') {
      args.output = next();
    } else if (arg === '--sru-url') {
      args.sruUrl = next();
    } else if (arg === '--record-type') {
      args.recordType = parseRecordType(arg, next());
    } else if (arg === '--operation') {
      args.operation = parseOperation(arg, next());
    } else if (arg === '--target-id') {
      args.targetId = next();
    } else if (arg === '--match-packages') {
      args.matchPackages = next();
    } else if (arg === '--merge') {
      args.merge = parseOnOff(arg, next());
    } else if (arg === '--unique') {
      args.unique = parseOnOff(arg, next());
    } else if (arg === '--validate') {
      args.validate = parseOnOff(arg, next());
    } else if (arg === '--stub-results') {
      args.stubResults = next();
    } else if (arg === '--replay') {
      args.replay = next();
    } else if (arg === '--record') {
      args.record = next();
    } else if (arg === '--match-failures-as-new') {
      args.matchFailuresAsNew = parseZeroOne(arg, next());
    } else if (arg === '--match-selector-rules') {
      args.matchSelectorRules = next();
    } else if (arg.startsWith('-')) {
      throw new CliError(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  // --help / bare invocation win over the record-file positional count:
  // both print usage with exit 0 (see main)
  if (positionals.length === 0) {
    args.help = true;
  }
  if (args.help) {
    if (positionals.length > 0) {
      args.recordFile = positionals[0];
    }
    return args;
  }
  if (positionals.length !== 1) {
    throw new CliError(`Expected exactly one record file, got ${positionals.length}. See --help.`);
  }
  args.recordFile = positionals[0];

  if (args.operation === 'UPDATE') {
    if (!args.targetId) {
      throw new CliError('--operation UPDATE requires --target-id <id>');
    }
    if (!isValidAlephId(args.targetId)) {
      throw new CliError(`Invalid --target-id: ${args.targetId} (expected a 9-digit Aleph id)`);
    }
    const f001 = getRecord001(args.recordFile);
    if (f001 !== undefined && f001 !== args.targetId) {
      throw new CliError(`--target-id ${args.targetId} does not match the record's 001 (${f001})`);
    }
  }

  const sruSourceFlags = [
    args.stubResults !== undefined && '--stub-results',
    args.replay !== undefined && '--replay',
    args.record !== undefined && '--record'
  ].filter(Boolean);
  if (sruSourceFlags.length > 1) {
    throw new CliError(`${sruSourceFlags.join(' and ')} cannot be combined (pick at most one SRU source flag)`);
  }
  return args;
}

function parseOnOff(flag, value) {
  if (value === 'on' || value === 'off') {
    return value;
  }
  throw new CliError(`Invalid value for ${flag}: ${value} (use on|off)`);
}

function parseZeroOne(flag, value) {
  if (value === '0' || value === '1') {
    return value === '1';
  }
  throw new CliError(`Invalid value for ${flag}: ${value} (use 0|1)`);
}

function parseOperation(flag, value) {
  if (value === 'CREATE' || value === 'UPDATE') {
    return value;
  }
  throw new CliError(`Invalid value for ${flag}: ${value} (use CREATE|UPDATE)`);
}

function parseRecordType(flag, value) {
  if (value === 'bib' || value === 'autname') {
    return value;
  }
  throw new CliError(`Invalid value for ${flag}: ${value} (use bib|autname)`);
}

// autname gates, mirroring the production 400 in the validator interface:
// merge and unique are not yet usable with non-bib records, and the match
// flags are no-ops for autname, so they are rejected explicitly instead of
// implying they do anything. Runs before the dynamic config import and any
// pipeline work
function validateRecordTypeGates(args, recordType) {
  if (recordType !== 'autname') {
    return;
  }
  if (args.merge === 'on' || args.unique === 'on') {
    throw new CliError('merge and unique are not yet usable with non-bib records (autname): use --merge off and --unique off');
  }
  const matchFlags = [
    args.matchPackages !== undefined && '--match-packages',
    args.matchSelectorRules !== undefined && '--match-selector-rules',
    args.matchFailuresAsNew !== undefined && '--match-failures-as-new'
  ].filter(Boolean);
  if (matchFlags.length > 0) {
    throw new CliError(`${matchFlags.join(', ')} are no-ops for autname records and cannot be combined with --record-type autname`);
  }
}

// Read the 001 value from the record file for the UPDATE --target-id mismatch check
function getRecord001(recordFile) {
  const recordObject = JSON.parse(readFileSync(recordFile, 'utf8'));
  const f001 = (recordObject.fields ?? []).find(field => field.tag === '001');
  return f001 ? f001.value : undefined;
}

// ---------------------------------------------------------------------------
// SRU stubbing / recording engine (--stub-results / --replay / --record)
//
// The pipeline's only live dependency is SRU HTTP traffic: the matchers'
// internal candidate-search clients and the getRecord client built by the
// validator factory. Both go through the global fetch with the full SRU
// request URL (the CQL query and the paging parameters are part of the URL),
// so an interceptor wrapped around globalThis.fetch for the duration of the
// pipeline run covers all SRU traffic.
//
// Fixture / capture file format (one format for all three flags):
//   {entries: [{url, status, body}]}
// where url is the exact SRU request URL (the lookup key: the paging
// parameters are part of the URL, so paged runs replay exactly as recorded),
// status is the HTTP status and body is the raw SRU XML response text.

// Placeholder SRU_URL for pure stub/replay runs: config.js requires the
// variable to be set, but no request ever reaches the network in stub mode.
// It also becomes the SRU request URL prefix the fixture entries are matched
// against, so a fixture for a URL-less run is keyed on this prefix
export const DUMMY_SRU_URL = 'http://sru.stub.invalid';

export function loadStubFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError(`Cannot read SRU fixture file ${file}: ${err.message}`);
  }

  let fixture;
  try {
    fixture = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`Invalid JSON in SRU fixture file ${file}: ${err.message}`);
  }

  if (fixture === null || typeof fixture !== 'object' || !Array.isArray(fixture.entries)) {
    throw new CliError(`Invalid SRU fixture file ${file}: expected {entries: [{url, status, body}]}`);
  }
  for (const entry of fixture.entries) {
    if (entry === null || typeof entry !== 'object' || typeof entry.url !== 'string' || typeof entry.status !== 'number' || typeof entry.body !== 'string') {
      throw new CliError(`Invalid SRU fixture file ${file}: each entry must have a string url, a numeric status and a string body`);
    }
  }
  return fixture;
}

// Fetch replacement for stub/replay runs: serves SRU requests from the
// fixture by exact URL match. A miss is a loud error — stub/replay runs
// never fall back to the network
export function createStubFetch({sruUrl, entries, label}) {
  const realFetch = globalThis.fetch;
  const byUrl = new Map(entries.map(entry => [entry.url, entry]));
  return async function stubFetch(url, init) {
    if (typeof url !== 'string' || !url.startsWith(sruUrl)) {
      return realFetch(url, init);
    }
    const entry = byUrl.get(url);
    if (!entry) {
      throw new Error(`No ${label} fixture entry for SRU URL: ${url} (never falls back to the network)`);
    }
    return new Response(entry.body, {status: entry.status, headers: {'Content-Type': 'text/xml'}});
  };
}

// Fetch replacement for record runs: passes the request through to the
// underlying fetch and appends {url, status, body} to entries for every
// SRU request
export function createRecordFetch({sruUrl, entries}) {
  const realFetch = globalThis.fetch;
  return async function recordFetch(url, init) {
    const response = await realFetch(url, init);
    if (typeof url === 'string' && url.startsWith(sruUrl)) {
      entries.push({url, status: response.status, body: await response.clone().text()});
    }
    return response;
  };
}

function sruModeOf(args) {
  if (args.stubResults) {
    return 'stub';
  }
  if (args.replay) {
    return 'replay';
  }
  if (args.record) {
    return 'record';
  }
  return 'live';
}

export async function runCli(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    return {args, trace: null, exitCode: 0};
  }

  // Resolve the record type before anything that touches config or the
  // pipeline: the flag wins, then env RECORD_TYPE, then bib. The autname
  // gates run right here, before the dynamic config import and any pipeline work
  const recordType = args.recordType ?? (process.env.RECORD_TYPE || 'bib');
  if (recordType !== 'bib' && recordType !== 'autname') {
    throw new CliError(`Invalid record type: ${recordType} (allowed values: bib, autname)`);
  }
  validateRecordTypeGates(args, recordType);

  const sruMode = sruModeOf(args);
  const givenUrl = args.sruUrl ?? process.env.SRU_URL;
  // stub/replay runs are fully offline: the URL only feeds config.js and the
  // fetch interceptor's match prefix (DUMMY_SRU_URL when absent). A would-skip
  // live run (all entry gates off) makes no SRU requests either, and an
  // autname CREATE run makes none at all (no match stage and no getRecord on
  // the CREATE path), so neither needs an endpoint: DUMMY_SRU_URL stands in
  // for config.js and is never hit
  const wouldSkip = args.merge !== 'on' && args.unique !== 'on' && args.validate !== 'on';
  const autnameCreateNoSru = recordType === 'autname' && args.operation === 'CREATE';
  const sruUrl = sruMode === 'stub' || sruMode === 'replay' || (sruMode === 'live' && (wouldSkip || autnameCreateNoSru)) ? givenUrl ?? DUMMY_SRU_URL : givenUrl;
  if (!sruUrl) {
    throw new CliError('No SRU endpoint given: use --sru-url <url> or set env SRU_URL');
  }

  applyCliEnv(args, sruUrl, recordType);

  const stopNoiseSuppression = suppressEnvNoise(process.env.LOG_LEVEL);
  let loaded;
  try {
    loaded = await loadValidator(recordType);
  } finally {
    stopNoiseSuppression();
  }
  const {validatorOptions, validationsFactory, MarcRecord, fixRecord} = loaded;

  // Swap in the fetch interceptor for the duration of the pipeline run so all
  // SRU traffic (matcher searches + rec.id lookups) goes through it; the
  // original global fetch is always restored afterwards (see module header note
  // on sequential runCli calls)
  const originalFetch = globalThis.fetch;
  let fetchImpl;
  let capturedEntries;
  if (sruMode === 'stub' || sruMode === 'replay') {
    const fixture = loadStubFile(sruMode === 'stub' ? args.stubResults : args.replay);
    fetchImpl = createStubFetch({sruUrl, entries: fixture.entries, label: sruMode});
  } else if (sruMode === 'record') {
    capturedEntries = [];
    fetchImpl = createRecordFetch({sruUrl, entries: capturedEntries});
  }
  if (fetchImpl) {
    globalThis.fetch = fetchImpl;
  }

  let trace;
  try {
    trace = await runPipeline({args, sruUrl, validatorOptions, validationsFactory, MarcRecord, fixRecord});
  } finally {
    globalThis.fetch = originalFetch;
    if (sruMode === 'record') {
      writeFileSync(args.record, `${JSON.stringify({entries: capturedEntries}, null, 2)}\n`);
    }
  }
  return {args, trace, exitCode: trace.exitCode};
}

// Apply CLI options to env BEFORE config.js is imported (it reads env at module load)
function applyCliEnv(args, sruUrl, recordType) {
  process.env.SRU_URL = sruUrl;
  process.env.RECORD_TYPE = recordType;
  if (args.matchPackages) {
    process.env.VALIDATOR_MATCH_PACKAGES = args.matchPackages;
  }
  if (args.matchSelectorRules) {
    process.env.MATCH_SELECTOR_RULES = args.matchSelectorRules;
  }
  // CLI always wants the matcher stage reports, also for zero-match records
  process.env.LOG_NO_MATCHES = process.env.LOG_NO_MATCHES || '1';
  // Keep the trace output clean: suppress library log noise by default (override with env LOG_LEVEL)
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
}

// ---------------------------------------------------------------------------
// Third-party env noise suppression
//
// Importing the validator dependencies emits two kinds of noise that their own
// configuration cannot silence:
//   - a "\u25c7 injected env (N) from .env" banner per dotenv.config() call: the
//     natural package (pulled in by @natlibfi/melinda-record-matching) calls
//     dotenv in five of its storage classes at module load (stdout)
//   - "No environment variable set for X, using default value: \u2026" lines from
//     readEnvironmentVariable in @natlibfi/melinda-{,backend-}commons, one per
//     defaulted config variable (stderr)
// Both fire at module load time, inside loadValidator's dynamic imports. The
// filter routes exactly those lines away for the duration of the imports. It is
// skipped when LOG_LEVEL=debug, so the noise stays visible while debugging
// config (the CLI defaults LOG_LEVEL to 'error' when unset; see applyCliEnv)
function suppressEnvNoise(logLevel) {
  if (logLevel === 'debug') {
    return () => {};
  }
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => {
    if (args.length === 1 && typeof args[0] === 'string' && /^No environment variable set for \S+, using default value: /.test(args[0])) {
      return;
    }
    originalError(...args);
  };
  console.log = (...args) => {
    if (args.length === 1 && typeof args[0] === 'string' && /\u25c7 injected env \(\d+\) from /.test(args[0])) {
      return;
    }
    originalLog(...args);
  };
  return () => {
    console.error = originalError;
    console.log = originalLog;
  };
}

// config.js is imported keyed by the record type: it reads env at module
// load and Node caches modules per URL, so each record type within one
// process gets its config from the environment set by the first runCli()
// call that used it
async function loadValidator(recordType) {
  const [{validatorOptions}, {validationsFactory}, {MarcRecord}, {fixes}] = await Promise.all([
    import(`./config.js?recordType=${recordType}`),
    import('./interfaces/validator/validations.js'),
    import('@natlibfi/marc-record'),
    import('@natlibfi/melinda-rest-api-commons')
  ]);
  return {validatorOptions, validationsFactory, MarcRecord, fixRecord: fixes.fixRecord};
}

async function runPipeline({args, sruUrl, validatorOptions, validationsFactory, MarcRecord, fixRecord}) {
  const recordObject = JSON.parse(readFileSync(args.recordFile, 'utf8'));

  // Production processLoad path: MarcRecord(fixRecord(data, preValidationFixOptions), {subfieldValues: false})
  const fixedRecordObject = await fixRecord(recordObject, validatorOptions.preValidationFixOptions);
  const record = new MarcRecord(fixedRecordObject, {subfieldValues: false});

  // No-op capturing mongoLogOperator (pattern from validations.test.js): the only
  // live dependency of the pipeline is SRU, Mongo/AMQP/Aleph are not needed
  const logItems = [];
  const mongoLogOperator = {
    addLogItem(item) {logItems.push(item);},
    removeBySequences() {}
  };

  const operation = args.operation;
  const merge = args.merge === 'on';
  const unique = args.unique === 'on';
  const validate = args.validate === 'on';
  const operationSettings = {validate, unique, merge};
  if (args.matchFailuresAsNew !== undefined) {
    operationSettings.matchFailuresAsNew = args.matchFailuresAsNew;
  }

  // Production entry gate (validator/index processLoad): the pipeline runs when any of
  // merge / unique / validate / noStream / prio is set; the CLI only sets the first three
  if (!merge && !unique && !validate) {
    return buildTrace({args, sruUrl, validatorOptions, merge, logItems, outcome: {kind: 'wouldSkipValidation'}, outHeaders: null});
  }

  // no sruClient/matchers injected -> factory builds the real ones from validatorOptions
  const {createValidations, updateValidations} = await validationsFactory(mongoLogOperator, fixRecord, validatorOptions, {});

  // Production fills recordMetadata from the record (all sourceIds for CREATE,
  // the first/best set for UPDATE); the CLI supplies only the blobSequence
  const recordMetadata = getRecordMetadata({record, recordMetadata: {blobSequence: 1}, getAllSourceIds: operation === 'CREATE'});

  const headers = {
    correlationId: `validator-cli-${Date.now()}`,
    operation,
    cataloger: {id: 'VALIDATOR_CLI'},
    recordMetadata,
    operationSettings
  };
  if (operation === 'UPDATE') {
    headers.id = args.targetId;
  }

  try {
    const {result, headers: outHeaders} = operation === 'UPDATE'
      ? await updateValidations({updateId: args.targetId, updateRecord: record, updateOperation: 'UPDATE', headers})
      : await createValidations({record, headers});
    // Production throws 422 for a failed validationService result; below the interface
    // layer the same result is reachable, so surface it as a decision
    const outcome = result.failed ? classifyFailed(result) : classifySuccess(outHeaders, operation);
    return buildTrace({args, sruUrl, validatorOptions, merge, logItems, outcome, outHeaders});
  } catch (err) {
    return buildTrace({args, sruUrl, validatorOptions, merge, logItems, outcome: classifyError(err), outHeaders: null});
  }
}

function buildTrace({args, sruUrl, validatorOptions, merge, logItems, outcome, outHeaders}) {
  const matchLog = logItems.find(item => item.logItemType === 'MATCH_LOG');
  const mergeLog = logItems.find(item => item.logItemType === 'MERGE_LOG');
  const exitCode = ['create', 'merge', 'skip', 'conflict', 'update', 'failed', 'wouldSkipValidation'].includes(outcome.kind) ? 0 : 1;
  const sruMode = sruModeOf(args);
  return {
    recordFile: args.recordFile,
    sruUrl,
    options: {
      operation: args.operation,
      recordType: validatorOptions.recordType,
      targetId: args.targetId,
      merge,
      unique: args.unique === 'on',
      validate: args.validate === 'on',
      sruMode,
      stubFile: args.stubResults ?? args.replay ?? null,
      captureFile: args.record ?? null,
      matchFailuresAsNew: args.matchFailuresAsNew,
      matchPackages: validatorOptions.matchOptionsList.map(o => o.matchPackageName),
      matchSelectorRules: validatorOptions.matchSelectorRules,
      stopWhenFound: validatorOptions.stopWhenFound,
      acceptZeroWithMaxCandidates: validatorOptions.acceptZeroWithMaxCandidates,
      thresholds: validatorOptions.matchOptionsList.map(o => o.detection.treshold)
    },
    matcherReports: matchLog ? matchLog.matcherReports : [],
    candidates: (matchLog ? matchLog.matchResult : []).map(summarizeCandidate),
    merge: mergeLog ? {
      databaseId: mergeLog.databaseId,
      preference: mergeLog.preference,
      mergedRecord: mergeLog.mergedRecord.toObject()
    } : null,
    outcome,
    headers: outHeaders,
    exitCode
  };
}

function summarizeCandidate(match) {
  return {
    id: match.candidate.id,
    probability: match.probability,
    matchSequence: match.matchSequence,
    action: match.action,
    preference: match.preference,
    message: match.message,
    matchers: (match.matcherReports ?? []).map(r => ({matcherSequence: r.matcherSequence, matcherName: r.matcherName, matchStatus: r.matchStatus}))
  };
}

function classifySuccess(outHeaders, requestedOperation) {
  const {operation, id, notes} = outHeaders;
  if (operation === 'UPDATE') {
    // An out-header UPDATE from a CREATE entry means the record was merged into a
    // candidate; a direct UPDATE probe keeps the UPDATE operation
    return {kind: requestedOperation === 'UPDATE' ? 'update' : 'merge', operation, id, notes: notes ?? []};
  }
  if (operation === 'SKIPPED_UPDATE' || operation === 'SKIPPED_CHANGE') {
    return {kind: 'skip', operation, id, notes: notes ?? []};
  }
  return {kind: 'create', operation, notes: notes ?? []};
}

function classifyFailed(result) {
  return {kind: 'failed', status: 422, messages: result.messages ?? []};
}

function classifyError(err) {
  if (err.status === 409) {
    return {kind: 'conflict', status: err.status, message: err.payload?.message, ids: err.payload?.ids ?? []};
  }
  return {kind: 'error', status: err.status, message: err.payload?.message ?? err.message};
}

export function printTrace(trace) {
  const {options} = trace;
  console.log(`Record:    ${trace.recordFile}`);
  console.log(`SRU:       ${trace.sruUrl}${trace.sruUrl === DUMMY_SRU_URL ? ' (placeholder, no SRU traffic)' : ''}`);
  if (options.stubFile) {
    console.log(`SRU source: ${options.sruMode} file ${options.stubFile}`);
  }
  if (options.captureFile) {
    console.log(`SRU capture: ${options.captureFile}`);
  }
  console.log(`Options:   operation=${options.operation} recordType=${options.recordType}${options.targetId ? ` targetId=${options.targetId}` : ''} merge=${options.merge} unique=${options.unique} validate=${options.validate} matchFailuresAsNew=${options.matchFailuresAsNew ?? 'config-default'} packages=${options.matchPackages.join(',')} selectorRules=${options.matchSelectorRules.join(',')} stopWhenFound=${options.stopWhenFound} thresholds=${JSON.stringify(options.thresholds)}`);
  console.log('');
  console.log(`Matcher stages (${trace.matcherReports.length}):`);
  for (const report of trace.matcherReports) {
    console.log(`  #${report.matcherSequence} ${report.matcherName}: matches=${report.matchAmount} ids=${JSON.stringify(report.matchIds ?? [])} candidates=${report.candidateCount ?? 'n/a'} conversionFailures=${report.conversionFailureCount ?? 'n/a'} status=${JSON.stringify(report.matchStatus ?? {})}`);
    if (report.matcherErrored) {
      console.log(`    ERRORED: ${report.matcherError}`);
    }
  }
  console.log('');
  console.log(`Candidates (${trace.candidates.length}):`);
  for (const candidate of trace.candidates) {
    console.log(`  ${candidate.id} probability=${candidate.probability} matchSequence=${candidate.matchSequence} action=${JSON.stringify(candidate.action)} preference=${JSON.stringify(candidate.preference)}${candidate.message ? ` message=${candidate.message}` : ''}`);
  }
  if (trace.merge) {
    console.log('');
    console.log(`Merged into ${trace.merge.databaseId} (preference ${JSON.stringify(trace.merge.preference)})`);
  }
  console.log('');
  console.log(`Decision: ${describeDecision(trace.outcome)}`);
  if (trace.outcome.kind === 'failed') {
    for (const message of trace.outcome.messages) {
      console.log(`  ${message.description}: ${message.messages?.join('; ') ?? 'invalid'}`);
    }
  }
}

function describeDecision(outcome) {
  switch (outcome.kind) {
    case 'create':
      return 'CREATE (new record)';
    case 'update':
      return `UPDATE ${outcome.id}`;
    case 'failed':
      return 'VALIDATION FAILED (422 in production)';
    case 'wouldSkipValidation':
      return 'WOULD_SKIP_VALIDATION (entry gate)';
    case 'merge':
      return `MERGE -> UPDATE into ${outcome.id} (${lastNote(outcome.notes) ?? 'merged'})`;
    case 'skip':
      return `${outcome.operation} (skip)${outcome.id ? ` into ${outcome.id}` : ''}: ${lastNote(outcome.notes) ?? 'skipped'}`;
    case 'conflict':
      return `409 CONFLICT: ${outcome.message}${outcome.ids.length ? ` (ids: ${outcome.ids.join(', ')})` : ''}`;
    default:
      return `${outcome.kind.toUpperCase()}: ${outcome.message ?? ''}${outcome.status ? ` (status ${outcome.status})` : ''}`;
  }
}

function lastNote(notes) {
  return notes.length > 0 ? notes[notes.length - 1] : undefined;
}

async function main() {
  try {
    const {args, trace, exitCode} = await runCli(process.argv.slice(2));
    if (args.help) {
      console.log(USAGE);
      process.exitCode = 0;
      return;
    }
    printTrace(trace);
    if (args.output) {
      writeFileSync(args.output, `${JSON.stringify(trace, null, 2)}\n`);
      console.log(`\nTrace written to ${args.output}`);
    }
    process.exitCode = exitCode;
  } catch (err) {
    console.error(`validator-cli error: ${err.message}`);
    process.exitCode = 1;
  }
}

// import.meta.url is realpathed by Node, while process.argv[1] is the literal
// path the user ran — comparing them directly misses symlinked invocations
// (.bin/melinda-validator-cli, npm link, npx .), so compare realpaths instead
const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (invokedDirectly) {
  main();
}
