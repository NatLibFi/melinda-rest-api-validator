import assert from 'node:assert';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it, before, after} from 'node:test';
import {MarcRecord} from '@natlibfi/marc-record';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import {parseArgs, runCli} from './cli.js';

describe('parseArgs (cli)', () => {
  it('Should parse a record file and all flags', () => {
    const args = parseArgs([
      'rec.json',
      '--sru-url', 'http://sru.example/bib/prv',
      '--match-packages', 'IDS,CONTENTALT',
      '--merge', 'on',
      '--match-failures-as-new', '1',
      '--match-selector-rules', 'LOW_COUNT,ENCODING_LEVEL',
      '-o', 'out.json'
    ]);
    assert.strictEqual(args.recordFile, 'rec.json');
    assert.strictEqual(args.sruUrl, 'http://sru.example/bib/prv');
    assert.strictEqual(args.matchPackages, 'IDS,CONTENTALT');
    assert.strictEqual(args.merge, 'on');
    assert.strictEqual(args.matchFailuresAsNew, true);
    assert.strictEqual(args.matchSelectorRules, 'LOW_COUNT,ENCODING_LEVEL');
    assert.strictEqual(args.output, 'out.json');
    assert.strictEqual(args.help, false);
  });

  it('Should default merge to off and leave matchFailuresAsNew undefined (config default)', () => {
    const args = parseArgs(['rec.json']);
    assert.strictEqual(args.merge, 'off');
    assert.strictEqual(args.matchFailuresAsNew, undefined);
    assert.strictEqual(args.sruUrl, undefined);
  });

  it('Should accept the --output long form', () => {
    const args = parseArgs(['rec.json', '--output', 'out.json']);
    assert.strictEqual(args.output, 'out.json');
  });

  it('Should fail on missing record file', () => {
    assert.throws(() => parseArgs(['--sru-url', 'http://x']), /Expected exactly one record file/);
  });

  it('Should fail on two record files', () => {
    assert.throws(() => parseArgs(['a.json', 'b.json']), /Expected exactly one record file/);
  });

  it('Should fail on unknown option', () => {
    assert.throws(() => parseArgs(['rec.json', '--nope']), /Unknown option: --nope/);
  });

  it('Should fail on invalid --merge value', () => {
    assert.throws(() => parseArgs(['rec.json', '--merge', 'yes']), /Invalid value for --merge/);
  });

  it('Should fail on invalid --match-failures-as-new value', () => {
    assert.throws(() => parseArgs(['rec.json', '--match-failures-as-new', 'true']), /Invalid value for --match-failures-as-new/);
  });

  it('Should fail on missing flag value', () => {
    assert.throws(() => parseArgs(['rec.json', '--sru-url']), /Missing value for --sru-url/);
  });

  it('Should fail on missing sru-url with no env fallback', async () => {
    const previous = process.env.SRU_URL;
    delete process.env.SRU_URL;
    try {
      await assert.rejects(runCli(['rec.json']), /No SRU endpoint given/);
    } finally {
      if (previous !== undefined) {
        process.env.SRU_URL = previous;
      }
    }
  });
});

// Pipeline wiring test: runCli() against the REAL validator pipeline (config +
// validationsFactory + real SRU client + real matchers) with the SRU HTTP
// transport stubbed (global fetch). The stub returns the same candidate record
// for every candidate search and for the rec.id lookup used on the merge path.
// The candidate shares the melinda 035 id with the incoming record, so the IDS
// matcher finds it at 1.0.
describe('runCli (cli pipeline wiring, stubbed SRU)', () => {
  const SRU_URL = 'http://sru-cli-test.example/bib/prv';
  const CANDIDATE_ID = '000012345';
  const record = {
    leader: '00000nam a2200000 a 4500',
    fields: [
      {tag: '001', value: CANDIDATE_ID},
      {tag: '035', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: '(FI-MELINDA)012345678'}]},
      {tag: '100', ind1: '0', ind2: ' ', subfields: [{code: 'a', value: 'author, of the'}]},
      {tag: '245', ind1: '1', ind2: ' ', subfields: [{code: 'a', value: 'cli test title.'}, {code: 'b', value: 'subtitle'}]},
      {tag: '020', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: '978-1-23456-7-8'}]}
    ]
  };

  const candidateXml = MARCXML.to(new MarcRecord(record, {subfieldValues: false}));
  const sruResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<zs:searchRetrieveResponse xmlns:zs="http://www.loc.gov/zhals/schema/v1/">
  <zs:numberOfRecords>1</zs:numberOfRecords>
  <zs:records>
    <zs:record>
      <zs:recordPosition>1</zs:recordPosition>
      <zs:recordData>${candidateXml}</zs:recordData>
    </zs:record>
  </zs:records>
</zs:searchRetrieveResponse>`;

  let recordFile;
  const originalFetch = globalThis.fetch;

  before(() => {
    const dir = mkdtempSync(join(tmpdir(), 'validator-cli-'));
    recordFile = join(dir, 'record.json');
    writeFileSync(recordFile, JSON.stringify(record));
    globalThis.fetch = async () => new Response(sruResponseXml, {status: 200, headers: {'Content-Type': 'text/xml'}});
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('Should run the full pipeline and report 409 CONFLICT with merge off', async () => {
    const {trace, exitCode} = await runCli([recordFile, '--sru-url', SRU_URL, '--match-packages', 'IDS']);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(trace.outcome.kind, 'conflict');
    assert.strictEqual(trace.outcome.status, 409);
    assert.deepStrictEqual(trace.outcome.ids, [CANDIDATE_ID]);
    assert.strictEqual(trace.options.merge, false);
    assert.deepStrictEqual(trace.options.matchPackages, ['IDS']);

    // IDS matcher stage report: found the candidate at the IDS stage
    const [idsReport] = trace.matcherReports;
    assert.strictEqual(idsReport.matcherName, 'IDS');
    assert.strictEqual(idsReport.matchAmount, 1);
    assert.deepStrictEqual(idsReport.matchIds, [CANDIDATE_ID]);

    // No matchValidation was run before the 409
    assert.strictEqual(trace.candidates.length, 1);
    assert.strictEqual(trace.candidates[0].id, CANDIDATE_ID);
    assert.strictEqual(trace.candidates[0].action, false);
    assert.strictEqual(trace.merge, null);
  });

  it('Should run the full pipeline and report the merge path with merge on', async () => {
    const {trace, exitCode} = await runCli([recordFile, '--sru-url', SRU_URL, '--match-packages', 'IDS', '--merge', 'on']);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(trace.options.merge, true);
    assert.strictEqual(trace.outcome.kind, 'merge');
    // The merge path ran to the end: final operation UPDATE into the candidate
    assert.strictEqual(trace.outcome.operation, 'UPDATE');
    assert.strictEqual(trace.outcome.id, CANDIDATE_ID);

    // matchValidation ran: the candidate is a valid merge candidate
    assert.strictEqual(trace.candidates[0].action, 'merge');

    // MERGE_LOG captured: merged into the candidate
    assert.strictEqual(trace.merge.databaseId, CANDIDATE_ID);
    assert.ok(trace.merge.mergedRecord);
  });
});
