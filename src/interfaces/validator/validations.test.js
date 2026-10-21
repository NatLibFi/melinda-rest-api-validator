import assert from 'node:assert';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {describe, it} from 'node:test';
import {MarcRecord} from '@natlibfi/marc-record';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import {validationsFactory} from './validations.js';

const LEADER = '00000nam a2200000 a 4500';

function makeRecord(fields) {
  return new MarcRecord({leader: LEADER, fields}, {subfieldValues: false});
}

function titleField(a, b) {
  const subfields = [{code: 'a', value: a}];
  if (b) subfields.push({code: 'b', value: b});
  return {tag: '245', ind1: '1', ind2: ' ', subfields};
}

function lowField(value) {
  return {tag: 'LOW', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: value}]};
}

// sruClient fake: searchRetrieve('rec.id=<id>') resolves with recordsById[id] as MARCXML
function makeSruClient(recordsById) {
  return {
    searchRetrieve(query) {
      const id = query.replace(/^rec\.id=/u, '');
      const emitter = new EventEmitter();
      setImmediate(() => {
        if (recordsById[id]) emitter.emit('record', MARCXML.to(recordsById[id]));
        emitter.emit('end');
      });
      return emitter;
    }
  };
}

// mongoLogOperator fake: captures log items
function makeLogOperator() {
  const logItems = [];
  return {logItems, addLogItem(item) {logItems.push(item);}};
}

function matchResult(options = {}) {
  const {matches = [], matchStatus = {status: true, stopReason: ''}, conversionFailures = [], candidateCount = 0} = options;
  return {matches, matchStatus, conversionFailures, candidateCount};
}

const baseValidatorOptions = {
  sruUrl: 'http://sru.example',
  recordType: 'bib',
  matchOptionsList: [{matchPackageName: 'TESTMATCHER'}],
  stopWhenFound: true,
  acceptZeroWithMaxCandidates: true,
  matchFailuresAsNew: false,
  logOptions: {logNoMatches: true}
};

function makeHeaders(overrides = {}, settingsOverrides = {}) {
  return {
    correlationId: 'corr-1',
    operation: 'CREATE',
    cataloger: {id: 'u1'},
    recordMetadata: {blobSequence: 1},
    operationSettings: {validate: false, unique: true, merge: false, ...settingsOverrides},
    ...overrides
  };
}

// Existing match-validation fixtures give record pairs that the real matchValidator accepts/rejects
function fixture(dir, file) {
  const path = new URL(`../../../test-fixtures/match-validation/${dir}/${file}`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function catField(value) {
  return {tag: 'CAT', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: value}]};
}

async function makeUpdateValidations({sruClient, fixRecord = async (r) => r.toObject(), options = {}}) {
  const logOperator = makeLogOperator();
  const {updateValidations} = await validationsFactory(
    logOperator,
    fixRecord,
    {...baseValidatorOptions, ...options},
    {sruClient, matchers: [async () => matchResult()]}
  );
  return {updateValidations, logOperator};
}

function incomingRecord(dir) {
  return new MarcRecord(fixture(dir, 'record.json'), {subfieldValues: false});
}

function matchesFromFixture(dir) {
  return fixture(dir, 'candidates.json').map(({id, probability, record}) => ({
    candidate: {id, record: new MarcRecord(record, {subfieldValues: false})},
    probability
  }));
}

async function makeCreateValidations({matchers, sruClient, options = {}, record}) {
  const logOperator = makeLogOperator();
  const {createValidations} = await validationsFactory(
    logOperator,
    async (r) => r.toObject(),
    {...baseValidatorOptions, ...options},
    {sruClient, matchers}
  );
  return {createValidations, logOperator, record};
}

describe('createValidations (no unique/merge)', () => {
  it('Should validate the record without running matchers', async () => {
    const record = makeRecord([titleField('foo.', 'bar')]);
    let matcherCalled = false;
    const matchers = [async () => {matcherCalled = true; return matchResult();}];
    const headers = makeHeaders({}, {unique: false, merge: false});
    const {createValidations, logOperator} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record});

    const {result, headers: newHeaders, recordMetadata} = await createValidations({record, headers});

    assert.equal(matcherCalled, false);
    assert.equal(result.failed, false);
    assert.deepStrictEqual(result.record, record);
    assert.deepStrictEqual(recordMetadata, headers.recordMetadata);
    assert.strictEqual(newHeaders, headers);
    assert.deepStrictEqual(logOperator.logItems, []);
  });
});

describe('createValidations (unique, no matches)', () => {
  it('Should return the validated new record and log a no-match matchAction', async () => {
    const record = makeRecord([titleField('foo.', 'bar')]);
    const matchers = [async () => matchResult({candidateCount: 5})];
    const headers = makeHeaders();
    const {createValidations, logOperator} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record});

    const {result, headers: newHeaders} = await createValidations({record, headers});

    assert.equal(result.failed, false);
    assert.deepStrictEqual(newHeaders.notes, ['Found 0 matching records in the database.']);
    assert.equal(logOperator.logItems.length, 1);
    const matchLog = logOperator.logItems[0];
    assert.equal(matchLog.logItemType, 'MATCH_LOG');
    assert.deepStrictEqual(matchLog.matchResult, []);
    assert.deepStrictEqual(matchLog.matcherReports, [{
      matcherSequence: 1,
      matcherName: 'TESTMATCHER',
      matchAmount: 0,
      candidateCount: 5,
      conversionFailureCount: 0,
      matchStatus: {status: true, stopReason: ''},
      matchIds: []
    }]);
    assert.strictEqual(matchLog.incomingRecord, record);
    assert.equal(matchLog.correlationId, 'corr-1');
  });

  it('Should not log a no-match matchAction when logNoMatches is false', async () => {
    const record = makeRecord([titleField('foo.', 'bar')]);
    const matchers = [async () => matchResult()];
    const headers = makeHeaders();
    const {createValidations, logOperator} = await makeCreateValidations({
      matchers, sruClient: makeSruClient({}), record,
      options: {logOptions: {logNoMatches: false}}
    });

    const {result} = await createValidations({record, headers});

    assert.equal(result.failed, false);
    assert.deepStrictEqual(logOperator.logItems, []);
  });
});

describe('createValidations (unique, matches found, no merge)', () => {
  it('Should throw 409 CONFLICT with the match ids and log the matches', async () => {
    const record = makeRecord([titleField('foo.', 'bar')]);
    const candidate = makeRecord([titleField('foo.', 'bar')]);
    const matchers = [async () => matchResult({matches: [{candidate: {id: '000020001', record: candidate}, probability: 100}]} )];
    const headers = makeHeaders();
    const {createValidations, logOperator} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record});

    await assert.rejects(createValidations({record, headers}), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.payload.message, 'Duplicates in database');
      assert.deepStrictEqual(err.payload.ids, ['000020001']);
      return true;
    });
    assert.equal(logOperator.logItems.length, 1);
    const matchLog = logOperator.logItems[0];
    assert.equal(matchLog.logItemType, 'MATCH_LOG');
    assert.equal(matchLog.matchResult.length, 1);
    assert.deepStrictEqual(matchLog.matchResult[0].candidate.id, '000020001');
    assert.equal(matchLog.matchResult[0].message, 'Validation not run');
  });
});

describe('createValidations (merge, matchValidation results)', () => {
  it('Should throw 409 CONFLICT when all matches fail matchValidation and matchFailuresAsNew is off', async () => {
    const record = incomingRecord('04-all-invalid');
    const matches = matchesFromFixture('04-all-invalid');
    const matchers = [async () => matchResult({matches, candidateCount: matches.length})];
    const headers = makeHeaders({}, {merge: true});
    const {createValidations, logOperator} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record});

    await assert.rejects(createValidations({record, headers}), (err) => {
      assert.equal(err.status, 409);
      assert.match(err.payload.message, /^MatchValidation for all 2 matches failed\./u);
      assert.deepStrictEqual(err.payload.ids, matches.map(({candidate: {id}}) => id));
      return true;
    });
    // the validated match results are logged before erroring
    assert.equal(logOperator.logItems.length, 1);
    assert.equal(logOperator.logItems[0].matchResult.length, 2);
  });

  it('Should treat the record as new when all matches fail matchValidation and matchFailuresAsNew is on in headers', async () => {
    const record = incomingRecord('04-all-invalid');
    const matches = matchesFromFixture('04-all-invalid');
    const matchers = [async () => matchResult({matches, candidateCount: matches.length})];
    const headers = makeHeaders({}, {merge: true, matchFailuresAsNew: true});
    const {createValidations} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record});

    const {result, headers: newHeaders} = await createValidations({record, headers});

    assert.equal(result.failed, false);
    // match note + matchValidation failure message are appended to the notes
    assert.equal(newHeaders.notes[0], `Found ${matches.length} matching records in the database.`);
    assert.match(newHeaders.notes[1], /^cand1: .*cand2:/u);
    // operation stays a CREATE
    assert.equal(newHeaders.operation, 'CREATE');
  });

  it('Should treat the record as new when all matches fail matchValidation and the factory default matchFailuresAsNew is on', async () => {
    const record = incomingRecord('04-all-invalid');
    const matches = matchesFromFixture('04-all-invalid');
    const matchers = [async () => matchResult({matches, candidateCount: matches.length})];
    const headers = makeHeaders({}, {merge: true});
    const {createValidations} = await makeCreateValidations({
      matchers, sruClient: makeSruClient({}), record,
      options: {matchFailuresAsNew: true}
    });

    const {result, headers: newHeaders} = await createValidations({record, headers});

    assert.equal(result.failed, false);
    assert.equal(newHeaders.operation, 'CREATE');
    assert.match(newHeaders.notes[1], /^cand1:/u);
  });
});

describe('createValidations (merge, valid match)', () => {
  it('Should merge with the best valid match and return an UPDATE result for the merged record', async () => {
    const record = incomingRecord('01-single-valid');
    const matches = matchesFromFixture('01-single-valid');
    const matchers = [async () => matchResult({matches, candidateCount: matches.length})];
    const sruClient = makeSruClient({cand1: matches[0].candidate.record});
    const headers = makeHeaders({}, {merge: true});
    const {createValidations, logOperator} = await makeCreateValidations({matchers, sruClient, record});

    const {result, headers: newHeaders} = await createValidations({record, headers});

    assert.equal(result.failed, false);
    assert(result.record instanceof MarcRecord);
    // operation becomes an UPDATE to the merged id, with match + merge notes
    assert.equal(newHeaders.operation, 'UPDATE');
    assert.equal(newHeaders.id, 'cand1');
    assert.equal(newHeaders.notes[0], 'Found 1 matching records in the database.');
    assert.match(newHeaders.notes[1], /^Merged to cand1 preferring/);
    // MATCH_LOG and MERGE_LOG are logged in order
    assert.deepStrictEqual(logOperator.logItems.map(({logItemType}) => logItemType), ['MATCH_LOG', 'MERGE_LOG']);
    const mergeLog = logOperator.logItems[1];
    assert.equal(mergeLog.databaseId, 'cand1');
    assert.strictEqual(mergeLog.incomingRecord, record);
    assert(mergeLog.mergedRecord instanceof MarcRecord);
  });

  it('Should prefer the database record when matchValidation finds no winner', async () => {
    // identical records: matchValidation passes with preference.value true (no winner)
    // -> mergeValidatedMatchResults uses the database record as base
    const record = incomingRecord('01-single-valid');
    const candidateRecord = new MarcRecord(fixture('01-single-valid', 'record.json'), {subfieldValues: false});
    const matches = [{candidate: {id: 'cand1', record: candidateRecord}, probability: 100}];
    const matchers = [async () => matchResult({matches, candidateCount: 1})];
    const sruClient = makeSruClient({cand1: candidateRecord});
    const headers = makeHeaders({}, {merge: true});
    const {createValidations, logOperator} = await makeCreateValidations({matchers, sruClient, record});

    const {headers: newHeaders} = await createValidations({record, headers});

    assert.match(newHeaders.notes[1], /^Merged to cand1 preferring database record\.$/u);
    const mergeLog = logOperator.logItems.find(({logItemType}) => logItemType === 'MERGE_LOG');
    assert.equal(mergeLog.preference.value, true);
    assert.equal(mergeLog.preference.recordName, 'databaseRecord');
  });
});

describe('createValidations (stopWhenFound)', () => {
  it('Should stop matching after the first match when stopWhenFound is on', async () => {
    const record = makeRecord([titleField('foo.', 'bar')]);
    const candidate1 = makeRecord([titleField('foo.', 'bar')]);
    const candidate2 = makeRecord([titleField('foo.', 'bar')]);
    const matchers = [
      async () => matchResult({matches: [{candidate: {id: '000020001', record: candidate1}, probability: 100}]}),
      async () => matchResult({matches: [{candidate: {id: '000020002', record: candidate2}, probability: 100}]})
    ];
    const options = {matchOptionsList: [{matchPackageName: 'M1'}, {matchPackageName: 'M2'}]};
    const headers = makeHeaders();
    const {createValidations, logOperator} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record, options});

    await assert.rejects(createValidations({record, headers}), (err) => {
      assert.equal(err.status, 409);
      assert.deepStrictEqual(err.payload.ids, ['000020001']);
      return true;
    });
    // only the first matcher ran
    assert.deepStrictEqual(logOperator.logItems[0].matcherReports.map(({matcherName}) => matcherName), ['M1']);
  });

  it('Should run all matchers and deduplicate matches when stopWhenFound is off', async () => {
    const record = makeRecord([titleField('foo.', 'bar')]);
    const candidate1 = makeRecord([titleField('foo.', 'bar')]);
    const matchers = [
      async () => matchResult({matches: [{candidate: {id: '000020001', record: candidate1}, probability: 100}]}),
      // second matcher returns the same candidate plus a new one
      async () => matchResult({matches: [
        {candidate: {id: '000020001', record: candidate1}, probability: 50},
        {candidate: {id: '000020002', record: makeRecord([titleField('foo.', 'bar')])}, probability: 90}
      ]})
    ];
    const options = {stopWhenFound: false, matchOptionsList: [{matchPackageName: 'M1'}, {matchPackageName: 'M2'}]};
    const headers = makeHeaders();
    const {createValidations, logOperator} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record, options});

    await assert.rejects(createValidations({record, headers}), (err) => {
      assert.equal(err.status, 409);
      // duplicate candidate deduplicated
      assert.deepStrictEqual(err.payload.ids, ['000020001', '000020002']);
      return true;
    });
    assert.deepStrictEqual(logOperator.logItems[0].matcherReports.map(({matcherName}) => matcherName), ['M1', 'M2']);
  });
});

describe('createValidations (untrustworthy zero matches)', () => {
  const zeroResult = (stopReason) => matchResult({matchStatus: {status: false, stopReason}});
  const headers = makeHeaders();

  it('Should treat zero matches with maxCandidates as new when acceptZeroWithMaxCandidates is on', async () => {
    const record = makeRecord([titleField('foo.', 'bar')]);
    const matchers = [async () => zeroResult('maxCandidates')];
    const {createValidations, logOperator} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record});

    const {result, headers: newHeaders} = await createValidations({record, headers});

    assert.equal(result.failed, false);
    assert.equal(newHeaders.notes[0], 'Found 0 matching records in the database.');
    assert.equal(logOperator.logItems[0].matcherReports[0].matchStatus.stopReason, 'maxCandidates');
  });

  it('Should throw 409 CONFLICT for zero matches with maxCandidates when acceptZeroWithMaxCandidates is off', async () => {
    const record = makeRecord([titleField('foo.', 'bar')]);
    const matchers = [async () => zeroResult('maxCandidates')];
    const options = {acceptZeroWithMaxCandidates: false};
    const {createValidations} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record, options});

    await assert.rejects(createValidations({record, headers}), (err) => {
      assert.equal(err.status, 409);
      assert.match(err.payload.message, /too many candidates/u);
      return true;
    });
  });

  it('Should throw 409 CONFLICT for zero matches with maxedQueries', async () => {
    const record = makeRecord([titleField('foo.', 'bar')]);
    const matchers = [async () => zeroResult('maxedQueries')];
    const {createValidations} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record});

    await assert.rejects(createValidations({record, headers}), (err) => {
      assert.equal(err.status, 409);
      assert.match(err.payload.message, /maxedQueries/u);
      return true;
    });
  });

  it('Should throw 422 UNPROCESSABLE_ENTITY for zero matches with conversionFailures', async () => {
    const record = makeRecord([titleField('foo.', 'bar')]);
    const matchers = [async () => matchResult({
      matchStatus: {status: false, stopReason: 'conversionFailures'},
      conversionFailures: [
        {status: 422, payload: {message: 'not convertable', id: '000000000'}},
        {status: 422, payload: {message: 'not convertable', id: '000020009'}}
      ]
    })];
    const {createValidations} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record});

    await assert.rejects(createValidations({record, headers}), (err) => {
      assert.equal(err.status, 422);
      assert.match(err.payload.message, /non-convertable candidates/u);
      // the zero-id conversion failure is filtered out of the payload ids
      assert.deepStrictEqual(err.payload.ids, ['000020009']);
      return true;
    });
  });
});

describe('createValidations (matcher errors)', () => {
  const headers = makeHeaders();
  const record = makeRecord([titleField('foo.', 'bar')]);
  const twoMatcherOptions = {matchOptionsList: [{matchPackageName: 'M1'}, {matchPackageName: 'M2'}]};

  it('Should continue to the next matcher when a non-last matcher generates no queries', async () => {
    const matchers = [
      async () => {throw new Error('Generated query list contains no queries');},
      async () => matchResult()
    ];
    const {createValidations} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record, options: twoMatcherOptions});

    const {result, headers: newHeaders} = await createValidations({record, headers});

    assert.equal(result.failed, false);
    assert.equal(newHeaders.notes[0], 'Found 0 matching records in the database.');
  });

  it('Should throw 422 UNPROCESSABLE_ENTITY when the last matcher generates no queries', async () => {
    const matchers = [
      async () => matchResult(),
      async () => {throw new Error('Generated query list contains no queries');}
    ];
    const {createValidations} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record, options: twoMatcherOptions});

    await assert.rejects(createValidations({record, headers}), (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.payload.message, 'Generated query list contains no queries');
      return true;
    });
  });

  it('Should throw 422 UNPROCESSABLE_ENTITY on an SRU SruSearchError from a matcher', async () => {
    const matchers = [async () => {throw new Error('SRU SruSearchError: something went wrong');}];
    const {createValidations} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record});

    await assert.rejects(createValidations({record, headers}), (err) => {
      assert.equal(err.status, 422);
      assert.match(err.payload.message, /SRU SruSearchError/u);
      return true;
    });
  });

  it('Should throw 500 when the matcher count does not match the matchOptionsList length', async () => {
    const matchers = [async () => matchResult()]; // one matcher, two options
    const {createValidations} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record, options: twoMatcherOptions});

    await assert.rejects(createValidations({record, headers}), (err) => {
      assert.equal(err.status, 500);
      assert.match(err.payload.message, /no matcher defined/u);
      return true;
    });
  });
});

describe('createValidations (merge, update validation)', () => {
  it('Should skip the update when the incoming changes are already in the database record', async () => {
    const hash = 'a'.repeat(64);
    const helmetF884 = {tag: '884', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: 'Helmet to Melinda MARC transformation'}, {code: 'k', value: hash}]};
    const record = incomingRecord('01-single-valid');
    record.appendField(helmetF884);
    const candidateRecord = new MarcRecord(fixture('01-single-valid', 'record.json'), {subfieldValues: false});
    candidateRecord.appendField({tag: '884', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: 'Helmet to Melinda MARC transformation'}, {code: 'k', value: hash}]});
    const matches = [{candidate: {id: 'cand1', record: candidateRecord}, probability: 100}];
    const matchers = [async () => matchResult({matches, candidateCount: 1})];
    const sruClient = makeSruClient({cand1: candidateRecord});
    const headers = makeHeaders({cataloger: 'IMP_HELMET'}, {merge: true});
    const {createValidations} = await makeCreateValidations({matchers, sruClient, record});

    const {result, headers: newHeaders} = await createValidations({record, headers});

    assert.equal(newHeaders.operation, 'SKIPPED_UPDATE');
    assert.equal(newHeaders.id, 'cand1');
    assert.match(newHeaders.notes[1], /No new incoming changes from IMP_HELMET detected/u);
    assert.deepStrictEqual(result, {record, validationResult: false});
  });
});

describe('createValidations (LOW-tag authorization)', () => {
  it('Should run the LOW-tag authorization check when the cataloger has an authorization list', async () => {
    const record = makeRecord([titleField('foo.', 'bar')]);
    const candidate = makeRecord([titleField('foo.', 'bar')]);
    const matchers = [async () => matchResult({matches: [{candidate: {id: '000020001', record: candidate}, probability: 100}]})];
    const headers = makeHeaders({cataloger: {id: 'u1', authorization: ['LOW']}}, {});
    const {createValidations} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record});

    // the record has no LOW-tagged fields, so authorization passes and the 409 conflict is reached
    await assert.rejects(createValidations({record, headers}), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.payload.message, 'Duplicates in database');
      return true;
    });
  });

  it('Should throw 403 FORBIDDEN when the incoming record has a non-authorized LOW tag', async () => {
    const record = makeRecord([titleField('foo.', 'bar'), lowField('FIN01-LOW-123456')]);
    const candidate = makeRecord([titleField('foo.', 'bar')]);
    const matchers = [async () => matchResult({matches: [{candidate: {id: '000020001', record: candidate}, probability: 100}]})];
    const headers = makeHeaders({cataloger: {id: 'u1', authorization: ['OTHER']}}, {});
    const {createValidations} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record});

    await assert.rejects(createValidations({record, headers}), (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.payload.message, 'Own authorization error');
      return true;
    });
  });

  it('Should skip the LOW-tag check when skipLowValidation is on', async () => {
    const record = makeRecord([titleField('foo.', 'bar'), lowField('FIN01-LOW-123456')]);
    const candidate = makeRecord([titleField('foo.', 'bar')]);
    const matchers = [async () => matchResult({matches: [{candidate: {id: '000020001', record: candidate}, probability: 100}]})];
    const headers = makeHeaders({cataloger: {id: 'u1', authorization: ['OTHER']}}, {skipLowValidation: true});
    const {createValidations} = await makeCreateValidations({matchers, sruClient: makeSruClient({}), record});

    // the LOW authorization check is skipped, so the flow reaches the 409 conflict instead of 403
    await assert.rejects(createValidations({record, headers}), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.payload.message, 'Duplicates in database');
      return true;
    });
  });
});

describe('updateValidations (entry)', () => {
  const updateId = '000020001';
  const existing = makeRecord([titleField('foo.', 'bar'), catField('u1 20240101120000')]);

  it('Should throw 400 BAD_REQUEST when no update id is given', async () => {
    const headers = makeHeaders({operation: 'UPDATE'}, {unique: false, merge: false});
    const {updateValidations} = await makeUpdateValidations({sruClient: makeSruClient({})});

    await assert.rejects(updateValidations({updateRecord: existing, headers}), (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.payload.message, 'Update id missing!');
      return true;
    });
  });

  it('Should throw 404 NOT_FOUND when the existing record is not found in the SRU', async () => {
    const headers = makeHeaders({operation: 'UPDATE', id: updateId}, {unique: false, merge: false});
    const {updateValidations} = await makeUpdateValidations({sruClient: makeSruClient({})});

    await assert.rejects(updateValidations({updateId, updateRecord: existing, headers}), (err) => {
      assert.equal(err.status, 404);
      assert.equal(err.payload.message, `Cannot find record ${updateId} to update`);
      return true;
    });
  });

  it('Should reject with the SRU error when the SRU search fails', async () => {
    const sruClient = {
      searchRetrieve() {
        const emitter = new EventEmitter();
        setImmediate(() => emitter.emit('error', new Error('SRU is down')));
        return emitter;
      }
    };
    const headers = makeHeaders({operation: 'UPDATE', id: updateId}, {unique: false, merge: false});
    const {updateValidations} = await makeUpdateValidations({sruClient});

    await assert.rejects(updateValidations({updateId, updateRecord: existing, headers}), /SRU is down/u);
  });
});

describe('updateValidations (existing record)', () => {
  const updateId = '000020001';

  it('Should throw 404 NOT_FOUND when the existing record is deleted', async () => {
    const base = makeRecord([titleField('foo.', 'bar'), catField('u1 20240101120000')]);
    const deleted = new MarcRecord({...base.toObject(), leader: `${base.leader.slice(0, 5)}d${base.leader.slice(6)}`}, {subfieldValues: false});
    const sruClient = makeSruClient({[updateId]: deleted});
    const headers = makeHeaders({operation: 'UPDATE', id: updateId}, {unique: false, merge: false});
    const {updateValidations} = await makeUpdateValidations({sruClient});

    await assert.rejects(updateValidations({updateId, updateRecord: base, headers}), (err) => {
      assert.equal(err.status, 404);
      assert.equal(err.payload.message, 'Existing record is deleted');
      return true;
    });
  });
});

describe('updateValidations (no merge)', () => {
  const updateId = '000020001';
  const makeHeadersForUpdate = () => makeHeaders({operation: 'UPDATE', id: updateId}, {unique: false, merge: false});

  it('Should return the validated incoming record when the update changes the record', async () => {
    const existing = makeRecord([titleField('foo.', 'bar'), catField('u1 20240101120000')]);
    const incoming = makeRecord([titleField('foo.', 'baz'), catField('u1 20240101120000')]);
    const sruClient = makeSruClient({[updateId]: existing});
    const headers = makeHeadersForUpdate();
    const {updateValidations, logOperator} = await makeUpdateValidations({sruClient});

    const {result, headers: newHeaders, recordMetadata} = await updateValidations({updateId, updateRecord: incoming, headers});

    assert.equal(result.failed, false);
    assert.deepStrictEqual(result.record, incoming);
    assert.deepStrictEqual(recordMetadata, headers.recordMetadata);
    assert.strictEqual(newHeaders, headers);
    assert.deepStrictEqual(logOperator.logItems, []);
  });

  it('Should throw 409 CONFLICT when the CAT modification histories do not match', async () => {
    const existing = makeRecord([titleField('foo.', 'bar'), catField('u1 20240101120000')]);
    const incoming = makeRecord([titleField('foo.', 'baz'), catField('u2 20240102120000')]);
    const sruClient = makeSruClient({[updateId]: existing});
    const headers = makeHeadersForUpdate();
    const {updateValidations} = await makeUpdateValidations({sruClient});

    await assert.rejects(updateValidations({updateId, updateRecord: incoming, headers}), (err) => {
      assert.equal(err.status, 409);
      assert.match(err.payload.message, /Modification history mismatch \(CAT\)/u);
      assert.deepStrictEqual(err.payload.ids, [updateId]);
      return true;
    });
  });

  it('Should report a validation failure when the 003 field is not FI-MELINDA', async () => {
    const existing = makeRecord([titleField('foo.', 'bar'), {tag: '003', value: 'FI-MELINDA'}, catField('u1 20240101120000')]);
    const incoming = makeRecord([titleField('foo.', 'baz'), {tag: '003', value: 'FI-OTHER'}, catField('u1 20240101120000')]);
    const sruClient = makeSruClient({[updateId]: existing});
    const headers = makeHeadersForUpdate();
    const {updateValidations} = await makeUpdateValidations({sruClient});

    const {result} = await updateValidations({updateId, updateRecord: incoming, headers});

    assert.equal(result.failed, true);
    assert(result.messages.length > 0);
  });
});

describe('updateValidations (no-change updates)', () => {
  const updateId = '000020001';
  const makeUpdateHeaders = (settings = {}, overrides = {}) => makeHeaders(
    {operation: 'UPDATE', id: updateId, ...overrides}, {unique: false, merge: false, ...settings}
  );
  const makePair = () => {
    const existing = makeRecord([titleField('foo.', 'bar'), catField('u1 20240101120000')]);
    const incoming = makeRecord([titleField('foo.', 'baz'), catField('u1 20240101120000')]);
    return {existing, incoming};
  };

  it('Should skip the update and mark the operation SKIPPED_CHANGE when nothing changes', async () => {
    const {existing} = makePair();
    const sruClient = makeSruClient({[updateId]: existing});
    const headers = makeUpdateHeaders({skipNoChangeUpdates: true});
    const {updateValidations} = await makeUpdateValidations({sruClient});

    const {result, headers: newHeaders} = await updateValidations({updateId, updateRecord: existing, headers});

    assert.equal(result.failed, false);
    assert.equal(newHeaders.operation, 'SKIPPED_CHANGE');
    assert.deepStrictEqual(newHeaders.notes, [`No changes detected while trying to update existing record ${updateId}, update skipped.`]);
  });

  it('Should append the no-change note to the existing header notes', async () => {
    const {existing} = makePair();
    const sruClient = makeSruClient({[updateId]: existing});
    const headers = makeUpdateHeaders({skipNoChangeUpdates: true}, {notes: ['previous note']});
    const {updateValidations} = await makeUpdateValidations({sruClient});

    const {headers: newHeaders} = await updateValidations({updateId, updateRecord: existing, headers});

    assert.equal(newHeaders.operation, 'SKIPPED_CHANGE');
    assert.equal(newHeaders.notes[0], 'previous note');
    assert.match(newHeaders.notes[1], /No changes detected/u);
  });

  it('Should update the record normally when the update changes the record and skipNoChangeUpdates is on', async () => {
    const {existing, incoming} = makePair();
    const sruClient = makeSruClient({[updateId]: existing});
    const headers = makeUpdateHeaders({skipNoChangeUpdates: true});
    const {updateValidations} = await makeUpdateValidations({sruClient});

    const {result, headers: newHeaders} = await updateValidations({updateId, updateRecord: incoming, headers});

    assert.equal(result.failed, false);
    assert.deepStrictEqual(result.record, incoming);
    assert.equal(newHeaders.operation, 'UPDATE');
    assert.strictEqual(newHeaders, headers);
  });

  it('Should not run the change check by default when skipNoChangeUpdates is off', async () => {
    const {existing} = makePair();
    const sruClient = makeSruClient({[updateId]: existing});
    const headers = makeUpdateHeaders({skipNoChangeUpdates: false});
    const {updateValidations} = await makeUpdateValidations({sruClient});

    const {headers: newHeaders} = await updateValidations({updateId, updateRecord: existing, headers});

    // identical records are not detected as no-change, the update is processed normally
    assert.equal(newHeaders.operation, 'UPDATE');
    assert.strictEqual(newHeaders, headers);
  });
});

describe('updateValidations (LOW-tag authorization)', () => {
  const updateId = '000020001';

  it('Should throw 403 FORBIDDEN when the update record has a non-authorized LOW tag', async () => {
    const existing = makeRecord([titleField('foo.', 'bar'), catField('u1 20240101120000')]);
    const incoming = makeRecord([titleField('foo.', 'baz'), lowField('FIN01-LOW-123456'), catField('u1 20240101120000')]);
    const sruClient = makeSruClient({[updateId]: existing});
    const headers = makeHeaders({operation: 'UPDATE', id: updateId, cataloger: {id: 'u1', authorization: ['OTHER']}}, {unique: false, merge: false});
    const {updateValidations} = await makeUpdateValidations({sruClient});

    await assert.rejects(updateValidations({updateId, updateRecord: incoming, headers}), (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.payload.message, 'Own authorization error');
      return true;
    });
  });

  it('Should skip the LOW-tag check when skipLowValidation is on', async () => {
    const existing = makeRecord([titleField('foo.', 'bar'), catField('u1 20240101120000')]);
    const incoming = makeRecord([titleField('foo.', 'baz'), lowField('FIN01-LOW-123456'), catField('u1 20240101120000')]);
    const sruClient = makeSruClient({[updateId]: existing});
    const headers = makeHeaders({operation: 'UPDATE', id: updateId, cataloger: {id: 'u1', authorization: ['OTHER']}}, {unique: false, merge: false, skipLowValidation: true});
    const {updateValidations} = await makeUpdateValidations({sruClient});

    const {result} = await updateValidations({updateId, updateRecord: incoming, headers});

    assert.equal(result.failed, false);
  });
});

describe('updateValidations (merge for updates)', () => {
  const updateId = '000020001';
  const makePair = () => {
    const existing = makeRecord([titleField('foo.', 'bar'), catField('u1 20240101120000')]);
    const incoming = makeRecord([titleField('foo.', 'baz'), catField('u1 20240101120000')]);
    return {existing, incoming};
  };
  const mergeHeaders = () => makeHeaders({operation: 'UPDATE', id: updateId}, {unique: false, merge: true});

  it('Should merge the incoming record into the existing record and return an UPDATE result', async () => {
    const {existing, incoming} = makePair();
    const sruClient = makeSruClient({[updateId]: existing});
    const headers = mergeHeaders();
    const {updateValidations, logOperator} = await makeUpdateValidations({sruClient});

    const {result, headers: newHeaders} = await updateValidations({updateId, updateRecord: incoming, headers});

    assert.equal(result.failed, false);
    assert(result.record instanceof MarcRecord);
    // the database record is preferred in update merges
    const mergedTitle = result.record.get(/^245$/u)[0];
    assert.deepStrictEqual(mergedTitle.subfields[0], {code: 'a', value: 'foo.'});
    assert.equal(newHeaders.operation, 'UPDATE');
    assert.equal(newHeaders.id, updateId);
    assert.deepStrictEqual(newHeaders.notes, [`Merged to ${updateId} preferring database record.`]);
    const mergeLog = logOperator.logItems.find(({logItemType}) => logItemType === 'MERGE_LOG');
    assert.equal(mergeLog.databaseId, updateId);
    assert.equal(mergeLog.preference.value, 'B');
  });

  it('Should append the merge note to the existing header notes', async () => {
    const {existing, incoming} = makePair();
    const sruClient = makeSruClient({[updateId]: existing});
    const headers = mergeHeaders();
    headers.notes = ['previous note'];
    const {updateValidations} = await makeUpdateValidations({sruClient});

    const {headers: newHeaders} = await updateValidations({updateId, updateRecord: incoming, headers});

    assert.equal(newHeaders.notes[0], 'previous note');
    assert.match(newHeaders.notes[1], /^Merged to \S+ preferring database record\.$/u);
  });

  it('Should not merge when the update operation is updateAfterMerge', async () => {
    const {existing, incoming} = makePair();
    const sruClient = makeSruClient({[updateId]: existing});
    const headers = mergeHeaders();
    const {updateValidations, logOperator} = await makeUpdateValidations({sruClient});

    const {result, headers: newHeaders} = await updateValidations({
      updateId, updateRecord: incoming, updateOperation: 'updateAfterMerge', headers
    });

    assert.equal(result.failed, false);
    assert.deepStrictEqual(result.record, incoming);
    assert.strictEqual(newHeaders, headers);
    assert.deepStrictEqual(logOperator.logItems, []);
  });

  it('Should throw 422 UNPROCESSABLE_ENTITY when the post-merge fixing fails', async () => {
    const {existing, incoming} = makePair();
    const sruClient = makeSruClient({[updateId]: existing});
    const headers = mergeHeaders();
    const fixRecord = async () => {throw new Error('fix boom');};
    const {updateValidations} = await makeUpdateValidations({sruClient, fixRecord});

    await assert.rejects(updateValidations({updateId, updateRecord: incoming, headers}), (err) => {
      assert.equal(err.status, 422);
      // BUG (pinned, not fixed): mergeRecordForUpdates sets `errorMessage = err` (the Error
      // object), so the message is the stringified object instead of err.message
      assert.match(err.payload.message, /Merge errored: Error: fix boom/u);
      return true;
    });
  });
});
