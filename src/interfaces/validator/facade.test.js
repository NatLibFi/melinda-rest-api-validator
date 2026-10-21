import assert from 'node:assert';
import {EventEmitter} from 'node:events';
import {describe, it} from 'node:test';
import {MarcRecord} from '@natlibfi/marc-record';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import {Error as ValidationError} from '@natlibfi/melinda-commons';
import validatorFactory from './index.js';

const LEADER = '00000nam a2200000 a 4500';

function makeRecordObject(fields) {
  return {leader: LEADER, fields};
}

function makeRecord(fields) {
  return new MarcRecord({leader: LEADER, fields}, {subfieldValues: false});
}

function titleField(a) {
  return {tag: '245', ind1: '1', ind2: ' ', subfields: [{code: 'a', value: a}]};
}

// sruClient fake: searchRetrieve('rec.id=<id>') resolves with recordsById[id] as MARCXML
// or rejects when recordsById[id] is an Error (reuses the validations.test.js pattern)
function makeSruClient(recordsById = {}) {
  return {
    searchRetrieve(query) {
      const id = query.replace(/^rec\.id=/u, '');
      const emitter = new EventEmitter();
      setImmediate(() => {
        const entry = recordsById[id];
        if (entry instanceof Error) {
          emitter.emit('error', entry);
          return;
        }
        if (entry) emitter.emit('record', MARCXML.to(entry));
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
  const {
    matches = [],
    matchStatus = {status: true, stopReason: ''},
    conversionFailures = [],
    candidateCount = 0
  } = options;
  return {matches, matchStatus, conversionFailures, candidateCount};
}

function makeValidatorOptions(overrides = {}) {
  return {
    recordType: 'bib',
    sruUrl: 'http://sru.example',
    preValidationFixOptions: {},
    preImportFixOptions: {},
    matchOptionsList: [{matchPackageName: 'TESTMATCHER'}],
    stopWhenFound: true,
    acceptZeroWithMaxCandidates: true,
    matchFailuresAsNew: false,
    logOptions: {logInputRecord: true, logNoMatches: true},
    ...overrides
  };
}

function makeHeaders(overrides = {}, settingsOverrides = {}) {
  return {
    correlationId: 'corr-1',
    operation: 'CREATE',
    cataloger: {id: 'u1'},
    recordMetadata: {blobSequence: 1},
    operationSettings: {validate: true, unique: false, merge: false, ...settingsOverrides},
    ...overrides
  };
}

async function makeProcess({
  validatorOptions = {},
  sruClient = makeSruClient(),
  matchers = [async () => matchResult()]
} = {}) {
  const logOperator = makeLogOperator();
  const process = await validatorFactory({
    validatorOptions: makeValidatorOptions(validatorOptions),
    mongoLogOperator: logOperator,
    sruClient,
    matchers
  });
  return {process, logOperator};
}

function findField(data, tag) {
  return data.fields.find(({tag: t}) => t === tag);
}

describe('processLoad (CREATE happy paths)', () => {
  it('Should return the validated record object with 001 set to the blob sequence id', async () => {
    const {process, logOperator} = await makeProcess();
    const headers = makeHeaders();
    const data = makeRecordObject([titleField('foo.')]);

    const result = await process(headers, data);

    assert.equal(result.headers.id, '000000001');
    assert.equal(result.headers.operation, 'CREATE');
    assert.deepStrictEqual(result.headers.recordMetadata.blobSequence, 1);
    // the missing f001 is added with the id from the blob sequence
    assert.equal(findField(result.data, '001').value, '000000001');
    assert.equal(logOperator.logItems.length, 1);
    const logItem = logOperator.logItems[0];
    assert.equal(logItem.logItemType, 'INPUT_RECORD_LOG');
    assert.equal(logItem.correlationId, 'corr-1');
    assert.equal(logItem.blobSequence, 1);
    assert.equal(logItem.cataloger, 'u1');
    assert(logItem.record instanceof MarcRecord);
    assert.deepStrictEqual(logItem.sourceIds, []);
  });

  it('Should apply the preValidationFix options before the record is validated', async () => {
    const preValidationFixOptions = {replacePrefixes: [{
      oldPrefix: 'FIN12', newPrefix: 'FIN01', prefixReplaceCodes: ['w']
    }]};
    const {process} = await makeProcess({validatorOptions: {preValidationFixOptions}});
    const headers = makeHeaders();
    const data = makeRecordObject([
      titleField('foo.'),
      {tag: '856', ind1: '4', ind2: ' ', subfields: [{code: 'w', value: '(FIN12)abc123'}]}
    ]);

    const result = await process(headers, data);

    const w = findField(result.data, '856').subfields[0];
    assert.equal(w.value, '(FIN01)abc123');
  });

  it('Should unserialise a MARCXML payload when format is set and return the validated record', async () => {
    const {process} = await makeProcess();
    const xml = MARCXML.to(makeRecord([titleField('foo.')]), {subfieldValues: false});
    const headers = makeHeaders({format: 'MARCXML'}, {prio: true});

    const result = await process(headers, xml);

    assert.equal(result.headers.id, '000000001');
    assert.equal(findField(result.data, '001').value, '000000001');
    const title = findField(result.data, '245');
    assert.equal(title.subfields[0].value, 'foo.');
  });

  it('Should throw 422 UNPROCESSABLE_ENTITY when the payload cannot be unserialised', async () => {
    const {process} = await makeProcess();
    const headers = makeHeaders({format: 'MARCXML'}, {prio: true});

    await assert.rejects(process(headers, 'this is not MARCXML'), (err) => {
      assert(err instanceof ValidationError);
      assert.equal(err.status, 422);
      assert.match(err.payload.message, /^Parsing input data failed\./u);
      return true;
    });
  });

  it('Should skip the validations and only update the 001 when no validation settings are on', async () => {
    let matcherCalled = false;
    const matchers = [async () => {matcherCalled = true; return matchResult();}];
    const {process, logOperator} = await makeProcess({matchers});
    const headers = makeHeaders({}, {validate: false, unique: false, merge: false});
    const data = makeRecordObject([titleField('foo.')]);

    const result = await process(headers, data);

    assert.equal(matcherCalled, false);
    assert.equal(result.headers.id, '000000001');
    assert.equal(findField(result.data, '001').value, '000000001');
    // only the input record is logged, no match log since matchers never ran
    assert.deepStrictEqual(logOperator.logItems.map(({logItemType}) => logItemType), ['INPUT_RECORD_LOG']);
  });
});

describe('processLoad (UPDATE paths)', () => {
  const updateId = '000020001';
  const catField = (value) => ({tag: 'CAT', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value}]});
  const makeUpdateData = () => makeRecordObject([
    {tag: '001', value: updateId},
    titleField('baz.'),
    catField('u1 20240101120000')
  ]);
  const makeExisting = () => makeRecord([
    {tag: '001', value: updateId},
    titleField('foo.'),
    catField('u1 20240101120000')
  ]);
  const makeUpdateHeaders = (overrides = {}) => makeHeaders(
    {operation: 'UPDATE', ...overrides}, {unique: false, merge: false}
  );

  it('Should run the update validations against the SRU record and return the updated record', async () => {
    const sruClient = makeSruClient({[updateId]: makeExisting()});
    const {process, logOperator} = await makeProcess({sruClient});
    const headers = makeUpdateHeaders();

    const result = await process(headers, makeUpdateData());

    assert.equal(result.headers.id, updateId);
    assert.equal(result.headers.operation, 'UPDATE');
    assert.equal(findField(result.data, '001').value, updateId);
    const title = findField(result.data, '245');
    assert.equal(title.subfields[0].value, 'baz.');
    // the existing record is fetched from the SRU with rec.id
    assert.deepStrictEqual(logOperator.logItems.map(({logItemType}) => logItemType), ['INPUT_RECORD_LOG']);
  });

  it('Should throw 422 UNPROCESSABLE_ENTITY when the update record has no valid id', async () => {
    const {process} = await makeProcess();
    const headers = makeUpdateHeaders();
    const data = makeRecordObject([titleField('foo.'), catField('u1 20240101120000')]);

    await assert.rejects(process(headers, data), (err) => {
      assert(err instanceof ValidationError);
      assert.equal(err.status, 422);
      assert.match(err.payload.message, /There is no valid id for updating the record\./u);
      assert.deepStrictEqual(err.payload.recordMetadata.blobSequence, 1);
      return true;
    });
  });

  it('Should rethrow the 404 not-found ValidationError with record metadata', async () => {
    const {process} = await makeProcess({sruClient: makeSruClient({})});
    const headers = makeUpdateHeaders({id: updateId});

    await assert.rejects(process(headers, makeUpdateData()), (err) => {
      assert(err instanceof ValidationError);
      assert.equal(err.status, 404);
      assert.equal(err.payload.message, `Cannot find record ${updateId} to update`);
      // the facade wraps the error payload with the combined record metadata
      assert.deepStrictEqual(err.payload.recordMetadata.blobSequence, 1);
      assert.ok(Array.isArray(err.payload.recordMetadata.sourceIds));
      return true;
    });
  });
});

describe('processLoad (error routing)', () => {
  const updateId = '000020001';
  const catField = (value) => ({tag: 'CAT', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value}]});

  it('Should throw 422 UNPROCESSABLE_ENTITY with the validation messages when validation fails', async () => {
    const {process} = await makeProcess();
    const headers = makeHeaders();
    const data = makeRecordObject([titleField('foo.'), {tag: '003', value: 'FI-OTHER'}]);

    await assert.rejects(process(headers, data), (err) => {
      assert(err instanceof ValidationError);
      assert.equal(err.status, 422);
      assert(Array.isArray(err.payload.message));
      assert(err.payload.message.length > 0);
      assert.ok(err.payload.recordMetadata);
      return true;
    });
  });

  it('Should wrap an unexpected error in a plain Error, not a ValidationError', async () => {
    const sruClient = makeSruClient({[updateId]: new Error('SRU is down')});
    const {process} = await makeProcess({sruClient});
    const headers = makeHeaders({operation: 'UPDATE', id: updateId}, {unique: false, merge: false});
    const data = makeRecordObject([{
      tag: '001', value: updateId
    }, titleField('baz.'), catField('u1 20240101120000')]);

    await assert.rejects(process(headers, data), (err) => {
      // BUG (pinned, not fixed): processLoad's catch does `throw new Error(err)` for any
      // non-ValidationError, so an unexpected error becomes a plain Error whose message is
      // the stringified original error instead of a 5xx ValidationError with a payload.
      assert(!(err instanceof ValidationError));
      assert(err instanceof Error);
      assert.equal(err.message, 'Error: SRU is down');
      return true;
    });
  });
});

describe('log items per path', () => {
  it('Should log MATCH_LOG after INPUT_RECORD_LOG for a unique CREATE with no matches', async () => {
    const matchers = [async () => matchResult({candidateCount: 3})];
    const {process, logOperator} = await makeProcess({matchers});
    const headers = makeHeaders({}, {unique: true});

    const result = await process(headers, makeRecordObject([titleField('foo.')]));

    assert.equal(result.headers.id, '000000001');
    assert.equal(result.headers.notes[0], 'Found 0 matching records in the database.');
    const logTypes = logOperator.logItems.map(({logItemType}) => logItemType);
    assert.deepStrictEqual(logTypes, ['INPUT_RECORD_LOG', 'MATCH_LOG']);
    const matchLog = logOperator.logItems[1];
    assert.equal(matchLog.correlationId, 'corr-1');
    assert.equal(matchLog.blobSequence, 1);
    assert(matchLog.incomingRecord instanceof MarcRecord);
    assert.deepStrictEqual(matchLog.matchResult, []);
    assert.equal(matchLog.matcherReports[0].matcherName, 'TESTMATCHER');
  });

  it('Should not log the input record when logInputRecord is off', async () => {
    const {process, logOperator} = await makeProcess({
      validatorOptions: {logOptions: {logInputRecord: false, logNoMatches: false}}
    });
    const headers = makeHeaders();

    const result = await process(headers, makeRecordObject([titleField('foo.')]));

    assert.equal(result.headers.id, '000000001');
    assert.deepStrictEqual(logOperator.logItems, []);
  });
});

describe('dispatch', () => {
  it('Should throw 500 ValidationError synchronously for an unknown operation', async () => {
    const {process} = await makeProcess();
    // process() is not async, the unknown-operation error is thrown synchronously
    assert.throws(() => process({operation: 'BLOW', operationSettings: {}}), (err) => {
      assert(err instanceof ValidationError);
      assert.equal(err.status, 500);
      assert.equal(err.payload.message, 'Unknown operation: BLOW');
      return true;
    });
  });

  it('Should route FIX to fixValidations and return {result: true} when the record is found', async () => {
    const fixHeaders = {
      operation: 'FIX',
      operationSettings: {fixType: 'FIX', validate: true},
      id: '000019640',
      correlationId: 'corr-1'
    };
    const sruClient = makeSruClient({'000019640': makeRecord([titleField('foo.')])});
    const {process} = await makeProcess({sruClient});

    const result = await process(fixHeaders);

    assert.deepStrictEqual(result, {result: true, recordMetadata: {}, headers: fixHeaders});
  });

  it('Should throw 404 NOT_FOUND for FIX when the record is not found in the SRU', async () => {
    const fixHeaders = {
      operation: 'FIX',
      operationSettings: {fixType: 'FIX', validate: true},
      id: '000019640',
      correlationId: 'corr-1'
    };
    const {process} = await makeProcess({sruClient: makeSruClient({})});

    await assert.rejects(process(fixHeaders), (err) => {
      assert(err instanceof ValidationError);
      assert.equal(err.status, 404);
      assert.deepStrictEqual(err.payload, {message: 'Cannot find record 000019640 to fix'});
      return true;
    });
  });

  it('Should throw 404 NOT_FOUND for FIX when the existing record is deleted', async () => {
    const deleted = new MarcRecord({
      leader: `${LEADER.slice(0, 5)}d${LEADER.slice(6)}`,
      fields: [{tag: '001', value: '000019640'}, titleField('foo.')]
    }, {subfieldValues: false});
    const fixHeaders = {
      operation: 'FIX',
      operationSettings: {fixType: 'FIX', validate: true},
      id: '000019640',
      correlationId: 'corr-1'
    };
    const {process} = await makeProcess({sruClient: makeSruClient({'000019640': deleted})});

    await assert.rejects(process(fixHeaders), (err) => {
      assert(err instanceof ValidationError);
      assert.equal(err.status, 404);
      assert.deepStrictEqual(err.payload, {message: 'Existing record is deleted', recordMetadata: {}});
      return true;
    });
  });

  it('Should throw 400 BAD_REQUEST when merge is set on a non-bib record', async () => {
    const {process} = await makeProcess({validatorOptions: {recordType: 'auth'}});
    const headers = makeHeaders({}, {merge: true});

    await assert.rejects(process(headers, makeRecordObject([titleField('foo.')])), (err) => {
      assert(err instanceof ValidationError);
      assert.equal(err.status, 400);
      assert.match(err.payload.message, /not yet usable with non-bib records\. <auth>/u);
      return true;
    });
  });
});
