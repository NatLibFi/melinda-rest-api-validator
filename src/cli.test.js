import assert from 'node:assert';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it, before, after} from 'node:test';
import {MarcRecord} from '@natlibfi/marc-record';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import {parseArgs, runCli, loadStubFile, createStubFetch, createRecordFetch, DUMMY_SRU_URL} from './cli.js';

// Shared fixtures for the stubbed-SRU pipeline tests: the candidate shares the
// melinda 035 id with the incoming record, so the IDS matcher finds it at 1.0
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
const emptySruResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<zs:searchRetrieveResponse xmlns:zs="http://www.loc.gov/zhals/schema/v1/">
  <zs:numberOfRecords>0</zs:numberOfRecords>
  <zs:records/>
</zs:searchRetrieveResponse>`;

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

  it('Should default unique to on and validate to off', () => {
    const args = parseArgs(['rec.json']);
    assert.strictEqual(args.unique, 'on');
    assert.strictEqual(args.validate, 'off');
  });

  it('Should parse --unique off and --validate on', () => {
    const args = parseArgs(['rec.json', '--unique', 'off', '--validate', 'on']);
    assert.strictEqual(args.unique, 'off');
    assert.strictEqual(args.validate, 'on');
  });

  it('Should fail on invalid --unique value', () => {
    assert.throws(() => parseArgs(['rec.json', '--unique', 'yes']), /Invalid value for --unique/);
  });

  it('Should fail on invalid --validate value', () => {
    assert.throws(() => parseArgs(['rec.json', '--validate', 'maybe']), /Invalid value for --validate/);
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

describe('parseArgs (cli, UPDATE options)', () => {
  it('Should default operation to CREATE and targetId to undefined', () => {
    const args = parseArgs(['rec.json']);
    assert.strictEqual(args.operation, 'CREATE');
    assert.strictEqual(args.targetId, undefined);
  });

  it('Should parse --operation UPDATE and --target-id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'validator-cli-'));
    const recordFile = join(dir, 'record.json');
    // No 001 in the record: --target-id is still accepted
    writeFileSync(recordFile, JSON.stringify({leader: '00000nam a2200000 a 4500', fields: []}));
    const args = parseArgs([recordFile, '--operation', 'UPDATE', '--target-id', '000012345']);
    assert.strictEqual(args.operation, 'UPDATE');
    assert.strictEqual(args.targetId, '000012345');
  });

  it('Should fail on invalid --operation value', () => {
    assert.throws(() => parseArgs(['rec.json', '--operation', 'DELETE']), /Invalid value for --operation/);
  });

  it('Should fail on UPDATE without --target-id', () => {
    assert.throws(() => parseArgs(['rec.json', '--operation', 'UPDATE']), /--operation UPDATE requires --target-id/);
  });

  it('Should fail on UPDATE with an invalid target id shape', () => {
    assert.throws(() => parseArgs(['rec.json', '--operation', 'UPDATE', '--target-id', 'abc12345']), /Invalid --target-id/);
  });

  it('Should fail when --target-id differs from the record 001', () => {
    const dir = mkdtempSync(join(tmpdir(), 'validator-cli-'));
    const recordFile = join(dir, 'record.json');
    writeFileSync(recordFile, JSON.stringify({leader: '00000nam a2200000 a 4500', fields: [{tag: '001', value: '000099999'}]}));
    assert.throws(() => parseArgs([recordFile, '--operation', 'UPDATE', '--target-id', '000012345']), /does not match the record's 001/);
  });

  it('Should accept --target-id that matches the record 001', () => {
    const dir = mkdtempSync(join(tmpdir(), 'validator-cli-'));
    const recordFile = join(dir, 'record.json');
    writeFileSync(recordFile, JSON.stringify({leader: '00000nam a2200000 a 4500', fields: [{tag: '001', value: '000012345'}]}));
    const args = parseArgs([recordFile, '--operation', 'UPDATE', '--target-id', '000012345']);
    assert.strictEqual(args.targetId, '000012345');
  });
});

describe('parseArgs (cli, SRU source flags)', () => {
  it('Should parse --stub-results, --replay and --record into their own fields', () => {
    const stubArgs = parseArgs(['rec.json', '--stub-results', 'stub.json']);
    assert.strictEqual(stubArgs.stubResults, 'stub.json');
    assert.strictEqual(stubArgs.replay, undefined);
    assert.strictEqual(stubArgs.record, undefined);

    const replayArgs = parseArgs(['rec.json', '--replay', 'capture.json']);
    assert.strictEqual(replayArgs.replay, 'capture.json');
    assert.strictEqual(replayArgs.stubResults, undefined);
    assert.strictEqual(replayArgs.record, undefined);

    const recordArgs = parseArgs(['rec.json', '--record', 'capture.json']);
    assert.strictEqual(recordArgs.record, 'capture.json');
    assert.strictEqual(recordArgs.stubResults, undefined);
    assert.strictEqual(recordArgs.replay, undefined);
  });

  it('Should fail when two of --stub-results / --replay / --record are given', () => {
    assert.throws(() => parseArgs(['rec.json', '--stub-results', 'a.json', '--replay', 'b.json']), /cannot be combined/);
    assert.throws(() => parseArgs(['rec.json', '--stub-results', 'a.json', '--record', 'b.json']), /cannot be combined/);
    assert.throws(() => parseArgs(['rec.json', '--replay', 'a.json', '--record', 'b.json']), /cannot be combined/);
  });

  it('Should parse the SRU source flags without a sru-url (runCli enforces it per mode)', () => {
    const args = parseArgs(['rec.json', '--stub-results', 'stub.json']);
    assert.strictEqual(args.sruUrl, undefined);
  });
});

describe('SRU stub/recording engine (cli)', () => {
  describe('loadStubFile', () => {
    it('Should load a valid fixture', () => {
      const dir = mkdtempSync(join(tmpdir(), 'validator-cli-'));
      const file = join(dir, 'fixture.json');
      const fixture = {entries: [{url: 'http://sru.example/bib/prv?query=1', status: 200, body: '<xml/>'}]};
      writeFileSync(file, JSON.stringify(fixture));
      assert.deepStrictEqual(loadStubFile(file), fixture);
    });

    it('Should fail on a missing file', () => {
      assert.throws(() => loadStubFile(join(tmpdir(), 'no-such-cli-fixture.json')), /Cannot read SRU fixture file/);
    });

    it('Should fail on invalid JSON', () => {
      const dir = mkdtempSync(join(tmpdir(), 'validator-cli-'));
      const file = join(dir, 'fixture.json');
      writeFileSync(file, '{nope');
      assert.throws(() => loadStubFile(file), /Invalid JSON in SRU fixture file/);
    });

    it('Should fail on a fixture without an entries array', () => {
      const dir = mkdtempSync(join(tmpdir(), 'validator-cli-'));
      const file = join(dir, 'fixture.json');
      writeFileSync(file, JSON.stringify({entries: 'nope'}));
      assert.throws(() => loadStubFile(file), /expected \{entries: \[\{url, status, body\}\]\}/);
    });

    it('Should fail on an entry without url, status or body', () => {
      const dir = mkdtempSync(join(tmpdir(), 'validator-cli-'));
      const file = join(dir, 'fixture.json');
      writeFileSync(file, JSON.stringify({entries: [{url: 'http://x', status: 200}]}));
      assert.throws(() => loadStubFile(file), /each entry must have a string url, a numeric status and a string body/);
    });
  });

  describe('createStubFetch', () => {
    const sruUrl = 'http://sru.stub';
    const entries = [
      {url: 'http://sru.stub?query=1', status: 200, body: '<xml one/>'},
      {url: 'http://sru.stub?query=2', status: 500, body: 'server error'}
    ];

    it('Should serve the fixture entry for an exact URL match', async () => {
      const stubFetch = createStubFetch({sruUrl, entries, label: 'stub'});
      const response = await stubFetch('http://sru.stub?query=1');
      assert.strictEqual(response.status, 200);
      assert.strictEqual(await response.text(), '<xml one/>');
    });

    it('Should serve non-200 entries as captured', async () => {
      const stubFetch = createStubFetch({sruUrl, entries, label: 'stub'});
      const response = await stubFetch('http://sru.stub?query=2');
      assert.strictEqual(response.status, 500);
      assert.strictEqual(await response.text(), 'server error');
    });

    it('Should reject loudly, naming the URL, on a fixture miss', async () => {
      const stubFetch = createStubFetch({sruUrl, entries, label: 'replay'});
      await assert.rejects(stubFetch('http://sru.stub?query=missing'), /No replay fixture entry for SRU URL: http:\/\/sru\.stub\?query=missing/);
    });

    it('Should pass non-SRU URLs through to the underlying fetch', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response('real', {status: 200});
      try {
        const stubFetch = createStubFetch({sruUrl, entries, label: 'stub'});
        const response = await stubFetch('http://elsewhere.example/x');
        assert.strictEqual(await response.text(), 'real');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('createRecordFetch', () => {
    const sruUrl = 'http://sru.rec';

    it('Should capture {url, status, body} for SRU URLs and still return the response', async () => {
      const entries = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async url => new Response(`<xml url="${url}"/>`, {status: 200});
      try {
        const recordFetch = createRecordFetch({sruUrl, entries});
        const response = await recordFetch('http://sru.rec?query=1');
        assert.strictEqual(await response.text(), '<xml url="http://sru.rec?query=1"/>');
        assert.deepStrictEqual(entries, [{url: 'http://sru.rec?query=1', status: 200, body: '<xml url="http://sru.rec?query=1"/>'}]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('Should capture non-200 SRU responses', async () => {
      const entries = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response('server error', {status: 500});
      try {
        const recordFetch = createRecordFetch({sruUrl, entries});
        const response = await recordFetch('http://sru.rec?query=1');
        assert.strictEqual(response.status, 500);
        assert.deepStrictEqual(entries, [{url: 'http://sru.rec?query=1', status: 500, body: 'server error'}]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('Should pass non-SRU URLs through without capturing', async () => {
      const entries = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response('real', {status: 200});
      try {
        const recordFetch = createRecordFetch({sruUrl, entries});
        const response = await recordFetch('http://elsewhere.example/x');
        assert.strictEqual(await response.text(), 'real');
        assert.deepStrictEqual(entries, []);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

// Pipeline wiring test: runCli() against the REAL validator pipeline (config +
// validationsFactory + real SRU client + real matchers) with the SRU HTTP
// transport stubbed (global fetch). The stub returns the same candidate record
// for every candidate search and for the rec.id lookup used on the merge and
// UPDATE paths. The candidate shares the melinda 035 id with the incoming
// record, so the IDS matcher finds it at 1.0.
describe('runCli (cli pipeline wiring, stubbed SRU)', () => {
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

  it('Should run the UPDATE pipeline and report update into the target id', async () => {
    const {trace, exitCode} = await runCli([recordFile, '--sru-url', SRU_URL, '--operation', 'UPDATE', '--target-id', CANDIDATE_ID]);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(trace.options.operation, 'UPDATE');
    assert.strictEqual(trace.options.targetId, CANDIDATE_ID);
    assert.strictEqual(trace.outcome.kind, 'update');
    assert.strictEqual(trace.outcome.operation, 'UPDATE');
    assert.strictEqual(trace.outcome.id, CANDIDATE_ID);

    // The UPDATE probe has no match stage and no merge
    assert.deepStrictEqual(trace.matcherReports, []);
    assert.deepStrictEqual(trace.candidates, []);
    assert.strictEqual(trace.merge, null);
  });

  it('Should run the merge path on UPDATE with merge on', async () => {
    const {trace, exitCode} = await runCli([recordFile, '--sru-url', SRU_URL, '--operation', 'UPDATE', '--target-id', CANDIDATE_ID, '--merge', 'on']);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(trace.options.merge, true);
    assert.strictEqual(trace.outcome.kind, 'update');
    assert.strictEqual(trace.outcome.id, CANDIDATE_ID);

    // MERGE_LOG captured: merged into the target, database record preferred
    assert.strictEqual(trace.merge.databaseId, CANDIDATE_ID);
    assert.strictEqual(trace.merge.preference.value, 'B');
    assert.ok(trace.merge.mergedRecord);
  });
});

// Validation-failure wiring: a record that fails the built-in validations (003 is
// present but not FI-MELINDA) with no candidates in the database. Production throws
// 422 for this; the CLI reports it as the `failed` outcome with exit 0.
describe('runCli (cli validation failure, stubbed SRU)', () => {
  const bad003Record = {
    leader: '00000nam a2200000 a 4500',
    fields: [
      {tag: '001', value: '000099999'},
      {tag: '003', value: 'FI-OTHER'},
      {tag: '035', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: '(FI-MELINDA)012345678'}]},
      {tag: '100', ind1: '0', ind2: ' ', subfields: [{code: 'a', value: 'author, of the'}]},
      {tag: '245', ind1: '1', ind2: ' ', subfields: [{code: 'a', value: 'cli test title.'}, {code: 'b', value: 'subtitle'}]},
      {tag: '020', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: '978-1-23456-7-8'}]}
    ]
  };

  let recordFile;
  const originalFetch = globalThis.fetch;

  before(() => {
    const dir = mkdtempSync(join(tmpdir(), 'validator-cli-'));
    recordFile = join(dir, 'record.json');
    writeFileSync(recordFile, JSON.stringify(bad003Record));
    globalThis.fetch = async () => new Response(emptySruResponseXml, {status: 200, headers: {'Content-Type': 'text/xml'}});
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('Should report VALIDATION FAILED with exit 0 when the record fails the built-in validations', async () => {
    const {trace, exitCode} = await runCli([recordFile, '--sru-url', SRU_URL, '--match-packages', 'IDS']);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(trace.outcome.kind, 'failed');
    assert.strictEqual(trace.outcome.status, 422);
    assert.ok(trace.outcome.messages.length > 0);
    assert.strictEqual(trace.outcome.messages[0].state, 'invalid');
    assert.strictEqual(trace.candidates.length, 0);
    assert.strictEqual(trace.merge, null);
  });
});

// UPDATE probe against an empty database: the rec.id lookup finds nothing, so the
// pipeline errors with 404 (probe-setup failure, not a decision)
describe('runCli (cli UPDATE not found, stubbed SRU)', () => {
  let recordFile;
  const originalFetch = globalThis.fetch;

  before(() => {
    const dir = mkdtempSync(join(tmpdir(), 'validator-cli-'));
    recordFile = join(dir, 'record.json');
    writeFileSync(recordFile, JSON.stringify(record));
    globalThis.fetch = async () => new Response(emptySruResponseXml, {status: 200, headers: {'Content-Type': 'text/xml'}});
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('Should report a 404 error when the target record is not in the SRU', async () => {
    const {trace, exitCode} = await runCli([recordFile, '--sru-url', SRU_URL, '--operation', 'UPDATE', '--target-id', CANDIDATE_ID]);

    assert.strictEqual(exitCode, 1);
    assert.strictEqual(trace.outcome.kind, 'error');
    assert.strictEqual(trace.outcome.status, 404);
    assert.match(trace.outcome.message, new RegExp(`Cannot find record ${CANDIDATE_ID} to update`));
  });
});

// UPDATE probe where the incoming record fails the built-in validations (003 is
// present but not FI-MELINDA): production throws 422, the CLI reports the `failed`
// outcome with exit 0
describe('runCli (cli UPDATE validation failure, stubbed SRU)', () => {
  const bad003UpdateRecord = {
    leader: '00000nam a2200000 a 4500',
    fields: [
      {tag: '001', value: CANDIDATE_ID},
      {tag: '003', value: 'FI-OTHER'},
      {tag: '035', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: '(FI-MELINDA)012345678'}]},
      {tag: '245', ind1: '1', ind2: ' ', subfields: [{code: 'a', value: 'cli test title.'}, {code: 'b', value: 'subtitle'}]}
    ]
  };
  // The stub returns the same record as the existing target record; the CAT
  // histories match and the incoming record fails the built-in validations
  const targetXml = MARCXML.to(new MarcRecord(bad003UpdateRecord, {subfieldValues: false}));
  const targetResponseXml = sruResponseXml.replace(candidateXml, targetXml);

  let recordFile;
  const originalFetch = globalThis.fetch;

  before(() => {
    const dir = mkdtempSync(join(tmpdir(), 'validator-cli-'));
    recordFile = join(dir, 'record.json');
    writeFileSync(recordFile, JSON.stringify(bad003UpdateRecord));
    globalThis.fetch = async () => new Response(targetResponseXml, {status: 200, headers: {'Content-Type': 'text/xml'}});
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('Should report VALIDATION FAILED when the incoming record fails the built-in validations', async () => {
    const {trace, exitCode} = await runCli([recordFile, '--sru-url', SRU_URL, '--operation', 'UPDATE', '--target-id', CANDIDATE_ID]);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(trace.outcome.kind, 'failed');
    assert.strictEqual(trace.outcome.status, 422);
    assert.ok(trace.outcome.messages.length > 0);
    assert.strictEqual(trace.merge, null);
  });
});

// Production entry-gate wiring: the pipeline runs when any of merge / unique /
// validate is on; with all three off the CLI reports WOULD_SKIP_VALIDATION
// without running the pipeline (and without any SRU traffic)
describe('runCli (cli entry gate, stubbed SRU)', () => {
  let recordFile;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  before(() => {
    const dir = mkdtempSync(join(tmpdir(), 'validator-cli-'));
    recordFile = join(dir, 'record.json');
    writeFileSync(recordFile, JSON.stringify(record));
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(emptySruResponseXml, {status: 200, headers: {'Content-Type': 'text/xml'}});
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('Should report WOULD_SKIP_VALIDATION with exit 0 when merge, unique and validate are all off', async () => {
    fetchCalls = 0;
    const {trace, exitCode} = await runCli([recordFile, '--sru-url', SRU_URL, '--unique', 'off']);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(trace.outcome.kind, 'wouldSkipValidation');
    assert.strictEqual(trace.options.merge, false);
    assert.strictEqual(trace.options.unique, false);
    assert.strictEqual(trace.options.validate, false);
    assert.strictEqual(fetchCalls, 0);
  });

  it('Should run the pipeline when only validate is on', async () => {
    const {trace, exitCode} = await runCli([recordFile, '--sru-url', SRU_URL, '--unique', 'off', '--validate', 'on']);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(trace.outcome.kind, 'create');
    assert.strictEqual(trace.outcome.operation, 'CREATE');
    assert.strictEqual(trace.options.unique, false);
    assert.strictEqual(trace.options.validate, true);
    // unique off: the match stage did not run, the record was validated as-is
    assert.deepStrictEqual(trace.matcherReports, []);
    assert.deepStrictEqual(trace.candidates, []);
  });

  it('Should run the pipeline when only unique is on (default)', async () => {
    fetchCalls = 0;
    const {trace, exitCode} = await runCli([recordFile, '--sru-url', SRU_URL, '--match-packages', 'IDS']);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(trace.outcome.kind, 'create');
    // the match stage ran against the (empty) database
    assert.ok(fetchCalls > 0);
    assert.strictEqual(trace.matcherReports.length, 1);
    assert.strictEqual(trace.candidates.length, 0);
  });

  it('Should report WOULD_SKIP_VALIDATION for UPDATE when the gate is off', async () => {
    fetchCalls = 0;
    const {trace, exitCode} = await runCli([recordFile, '--sru-url', SRU_URL, '--operation', 'UPDATE', '--target-id', CANDIDATE_ID, '--unique', 'off']);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(trace.outcome.kind, 'wouldSkipValidation');
    assert.strictEqual(trace.options.operation, 'UPDATE');
    assert.strictEqual(trace.options.targetId, CANDIDATE_ID);
    assert.strictEqual(fetchCalls, 0);
  });
});

// --stub-results: the fixture (a capture of a live run) serves all SRU traffic.
// The test never provides stub responses itself — a sentinel global fetch that
// throws proves the run is fully offline; the stub comes from the CLI flag
describe('runCli (cli --stub-results, offline fixture)', () => {
  let recordFile;
  let fixtureFile;
  let emptyFixtureFile;
  const originalFetch = globalThis.fetch;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'validator-cli-'));
    recordFile = join(dir, 'record.json');
    fixtureFile = join(dir, 'fixture.json');
    emptyFixtureFile = join(dir, 'empty.json');
    writeFileSync(recordFile, JSON.stringify(record));
    writeFileSync(emptyFixtureFile, JSON.stringify({entries: []}));
    // Capture a fixture from a "live" run whose transport is faked by the test
    globalThis.fetch = async () => new Response(sruResponseXml, {status: 200, headers: {'Content-Type': 'text/xml'}});
    await runCli([recordFile, '--sru-url', SRU_URL, '--match-packages', 'IDS', '--record', fixtureFile]);
    globalThis.fetch = originalFetch;
  });

  it('Should run the full pipeline fully offline from the stub file (no fetch call at all)', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('network disabled in test');
    };
    try {
      const {trace, exitCode} = await runCli([recordFile, '--sru-url', SRU_URL, '--match-packages', 'IDS', '--stub-results', fixtureFile]);

      assert.strictEqual(exitCode, 0);
      assert.strictEqual(trace.outcome.kind, 'conflict');
      assert.strictEqual(trace.outcome.status, 409);
      assert.strictEqual(trace.options.sruMode, 'stub');
      assert.strictEqual(trace.options.stubFile, fixtureFile);
      assert.strictEqual(trace.options.captureFile, null);
      // the IDS matcher stage ran against the stubbed candidate
      assert.strictEqual(trace.matcherReports[0].matchAmount, 1);
      assert.deepStrictEqual(trace.matcherReports[0].matchIds, [CANDIDATE_ID]);
      assert.strictEqual(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('Should not require --sru-url for a stub run (placeholder SRU_URL used, no traffic)', async () => {
    const previousSruUrl = process.env.SRU_URL;
    delete process.env.SRU_URL;
    globalThis.fetch = async () => { throw new Error('network disabled in test'); };
    try {
      const {trace, exitCode} = await runCli([recordFile, '--stub-results', emptyFixtureFile, '--unique', 'off']);

      assert.strictEqual(exitCode, 0);
      assert.strictEqual(trace.outcome.kind, 'wouldSkipValidation');
      assert.strictEqual(trace.sruUrl, DUMMY_SRU_URL);
      assert.strictEqual(trace.options.sruMode, 'stub');
    } finally {
      if (previousSruUrl !== undefined) {
        process.env.SRU_URL = previousSruUrl;
      }
      globalThis.fetch = originalFetch;
    }
  });
});

// --record -> --replay round trip: a fake live SRU (installed by the test) is
// recorded to a capture file; a second run replays the capture offline (sentinel
// fetch that throws) and must produce the same decision and matcher sections
describe('runCli (cli --record / --replay round-trip)', () => {
  let recordFile;
  let captureFile;
  const originalFetch = globalThis.fetch;

  before(() => {
    const dir = mkdtempSync(join(tmpdir(), 'validator-cli-'));
    recordFile = join(dir, 'record.json');
    captureFile = join(dir, 'capture.json');
    writeFileSync(recordFile, JSON.stringify(record));
  });

  it('Should record a live run and replay it with identical decision and matcher sections', async () => {
    // Run 1: record; the fake "live" SRU answers every request with the candidate
    globalThis.fetch = async () => new Response(sruResponseXml, {status: 200, headers: {'Content-Type': 'text/xml'}});
    let recorded;
    try {
      const recordedResult = await runCli([recordFile, '--sru-url', SRU_URL, '--match-packages', 'IDS', '--merge', 'on', '--record', captureFile]);
      recorded = recordedResult.trace;
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.strictEqual(recorded.options.sruMode, 'record');
    assert.strictEqual(recorded.options.captureFile, captureFile);
    assert.strictEqual(recorded.outcome.kind, 'merge');

    // The capture file exists in the unified format, keyed by exact SRU request URLs
    const captured = JSON.parse(readFileSync(captureFile, 'utf8'));
    assert.ok(Array.isArray(captured.entries));
    assert.ok(captured.entries.length > 0);
    for (const entry of captured.entries) {
      assert.ok(entry.url.startsWith(SRU_URL));
      assert.strictEqual(entry.status, 200);
    }

    // Run 2: replay the capture; the sentinel fetch proves the run never hits the network
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('network disabled in test');
    };
    let replayed;
    try {
      const replayedResult = await runCli([recordFile, '--sru-url', SRU_URL, '--match-packages', 'IDS', '--merge', 'on', '--replay', captureFile]);
      replayed = replayedResult.trace;
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.strictEqual(fetchCalls, 0);
    assert.strictEqual(replayed.options.sruMode, 'replay');
    assert.strictEqual(replayed.options.stubFile, captureFile);
    assert.strictEqual(replayed.options.captureFile, null);

    // Decision + matcher sections identical between record and replay runs
    assert.deepStrictEqual(replayed.outcome, recorded.outcome);
    assert.deepStrictEqual(replayed.matcherReports, recorded.matcherReports);
    assert.deepStrictEqual(replayed.candidates, recorded.candidates);
    assert.deepStrictEqual(replayed.merge, recorded.merge);
  });

  it('Should require a sru-url for record runs (no env fallback)', async () => {
    const previousSruUrl = process.env.SRU_URL;
    delete process.env.SRU_URL;
    try {
      await assert.rejects(runCli(['rec.json', '--record', 'capture.json']), /No SRU endpoint given/);
    } finally {
      if (previousSruUrl !== undefined) {
        process.env.SRU_URL = previousSruUrl;
      }
    }
  });
});
