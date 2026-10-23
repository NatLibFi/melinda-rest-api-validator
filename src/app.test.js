import assert from 'node:assert';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {describe, it} from 'node:test';
import {MarcRecord} from '@natlibfi/marc-record';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import startApp from './app.js';

const LEADER = '00000nam a2200000 a 4500';

function titleField(value) {
  return {tag: '245', ind1: '1', ind2: ' ', subfields: [{code: 'a', value: value}]};
}

function catField(value) {
  return {tag: 'CAT', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: value}]};
}

function fixture(dir, file) {
  const path = new URL(`../test-fixtures/match-validation/${dir}/${file}`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8'));
}

// sruClient fake (reuses the facade.test.js pattern): searchRetrieve('rec.id=<id>')
// resolves with recordsById[id] as MARCXML, or errors when the entry is an Error
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
        if (entry) {
          const record = entry instanceof MarcRecord ? entry : new MarcRecord(entry, {subfieldValues: false});
          emitter.emit('record', MARCXML.to(record, {subfieldValues: false}));
        }
        emitter.emit('end');
      });
      return emitter;
    }
  };
}

function matchResult(options = {}) {
  const {matches = [], matchStatus = {status: true, stopReason: ''}, conversionFailures = [], candidateCount = 0} = options;
  return {matches, matchStatus, conversionFailures, candidateCount};
}

// Fake amqpOperator: in-memory named queues + audit state.
// Loop exit design: the poll loop can never resolve, so every test runs in two
// phases. Phase 1: onEvent(type, detail, times) resolves a promise when the
// observable final condition is met (deferred one setImmediate so the rest of
// the current processing chain settles first); the test asserts on fake state.
// Phase 2: stop() makes the next checkQueue call reject with a plain (non-Api)
// Error; the app rejects with it (checkQueue is awaited OUTSIDE the try
// block, so the rejection propagates directly and the catch's `message`
// read is never reached - the catch can only run when checkQueue succeeded,
// i.e. when message is already initialized) and the loop unwinds.
function makeAmqpOperator() {
  const queues = new Map();
  const state = {checked: [], checkAttempts: [], sent: [], acked: [], removed: []};
  const waiters = [];
  let failNextCheckQueue = null;
  let stopped = false;

  const trigger = (type, detail) => {
    for (const waiter of waiters) {
      if (waiter.type !== type) continue;
      if (waiter.detail !== undefined && waiter.detail !== detail) continue;
      waiter.seen += 1;
      if (waiter.seen >= waiter.times) setImmediate(waiter.resolve);
    }
  };

  const onEvent = (type, detail, times = 1) =>
    new Promise((resolve) => waiters.push({type, detail, times, seen: 0, resolve}));

  // Messages enqueued via sendToQueue are rewrapped into the consumer shape
  // ({properties, content}) that the poll loop expects.
  const toMessage = (entry) => {
    if (entry.properties) return entry;
    return {
      properties: {correlationId: entry.correlationId, headers: entry.headers},
      content: Buffer.from(JSON.stringify({data: entry.data}))
    };
  };

  // ack removes the message from its queue: the real operator only redelivers
  // non-acked messages, so an un-removed head message would loop forever
  const isSameMessage = (entry, message) => {
    if (entry.properties) return entry === message;
    return entry.headers === message.properties.headers
      && entry.correlationId === message.properties.correlationId;
  };

  return {
    state,
    queues,
    seedMessage(queue, message) {
      queues.set(queue, [...(queues.get(queue) || []), message]);
    },
    onEvent,
    stop() {
      stopped = true;
    },
    failNextCheckQueueWith(error) {
      failNextCheckQueue = error;
    },
    async checkQueue({queue, style, purge}) {
      state.checkAttempts.push(queue);
      if (failNextCheckQueue) {
        const error = failNextCheckQueue;
        failNextCheckQueue = null;
        trigger('check-fail', queue);
        throw error;
      }
      if (stopped) throw new Error('STOP');
      state.checked.push({queue, style, purge});
      const messages = queues.get(queue) || [];
      if (style === 'one') {
        if (messages.length === 0) return null;
        trigger('check', queue);
        return toMessage(messages[0]);
      }
      if (purge) queues.delete(queue);
      return messages;
    },
    ackMessages(messages) {
      state.acked.push(...messages);
      for (const [queue, entries] of queues) {
        queues.set(queue, entries.filter((entry) =>
          !messages.some((message) => isSameMessage(entry, message))));
      }
      trigger('ack', messages[0].properties.correlationId);
    },
    async sendToQueue({queue, ...rest}) {
      queues.set(queue, [...(queues.get(queue) || []), {queue, ...rest}]);
      state.sent.push({queue, ...rest});
      trigger('send', queue);
    },
    removeQueue(queue) {
      queues.delete(queue);
      state.removed.push(queue);
      trigger('remove', queue);
    }
  };
}

// Fake mongoOperator: correlationId -> queueItem map with audit trails.
// Loop exit: same two-phase design as makeAmqpOperator; getOne rejects once
// stop() has been called.
function makeMongoOperator({queueItems = [], streams = {}, freshStates = {}}) {
  const items = new Map();
  for (const item of queueItems) {
    items.set(item.correlationId, {
      ...item,
      stateLog: [],
      importJobs: [],
      operations: [],
      recordResponses: [],
      splitterReports: [],
      blobSizes: []
    });
  }
  const waiters = [];
  let stopped = false;

  const trigger = (type, detail) => {
    for (const waiter of waiters) {
      if (waiter.type !== type) continue;
      if (waiter.detail !== undefined && waiter.detail !== detail) continue;
      waiter.seen += 1;
      if (waiter.seen >= waiter.times) setImmediate(waiter.resolve);
    }
  };

  const onEvent = (type, detail, times = 1) =>
    new Promise((resolve) => waiters.push({type, detail, times, seen: 0, resolve}));

  return {
    items,
    onEvent,
    async getOne({queueItemState}) {
      if (stopped) throw new Error('STOP');
      for (const item of items.values()) {
        if (item.state === queueItemState) return item;
      }
      return undefined;
    },
    async setState({correlationId, state: newState, errorMessage, errorStatus}) {
      const item = items.get(correlationId);
      item.state = newState;
      item.stateLog.push({state: newState, errorMessage, errorStatus});
      trigger('state', newState);
    },
    // checkAndSetState: returns {status:'updated'} and sets the state, or
    // returns {status:'timeout'} and moves the queueItem to ABORT
    // (mirrors the real operator contract)
    async checkAndSetState({correlationId, state}) {
      const item = items.get(correlationId);
      const scripted = freshStates[correlationId] || [];
      const fresh = scripted.length > 0 ? scripted.shift() : true;
      item.state = fresh ? state : 'ABORT';
      item.stateLog.push({state: item.state, fresh});
      trigger('state', item.state);
      return {status: fresh ? 'updated' : 'timeout', queueItem: item};
    },
    stop() {
      stopped = true;
    },
    async setOperation({correlationId, operation}) {
      items.get(correlationId).operations.push({addOperation: operation, removeOperation: undefined});
    },
    async setOperations({correlationId, addOperation, removeOperation}) {
      items.get(correlationId).operations.push({addOperation, removeOperation});
    },
    async checkAndSetImportJobState({correlationId, operation, importJobState}) {
      items.get(correlationId).importJobs.push({operation, importJobState, checked: true});
    },
    async setImportJobState({correlationId, operation, importJobState}) {
      items.get(correlationId).importJobs.push({operation, importJobState, checked: false});
    },
    async getStream(correlationId) {
      return streams[correlationId];
    },
    async pushMessages({correlationId, messages, messageField}) {
      const item = items.get(correlationId);
      if (messageField === 'records') item.recordResponses.push(...messages);
      else item.splitterReports.push(...messages);
      trigger('push', messageField);
    },
    async setBlobSize({correlationId, blobSize}) {
      items.get(correlationId).blobSizes.push(blobSize);
    }
  };
}

function makeLogOperator() {
  const state = {logItems: [], removed: []};
  return {
    state,
    addLogItem(logItem) {state.logItems.push(logItem);},
    removeBySequences(correlationId, sequences) {state.removed.push({correlationId, sequences});}
  };
}

function makePrioHeaders(overrides = {}, settings = {}) {
  return {
    correlationId: 'corr1',
    operation: 'CREATE',
    cataloger: {id: 'u1'},
    recordMetadata: {blobSequence: 1},
    operationSettings: {validate: false, unique: false, merge: false, ...settings},
    ...overrides
  };
}

function makePrioMessage({correlationId, headers, data}) {
  return {
    properties: {correlationId, headers},
    content: Buffer.from(JSON.stringify({data}))
  };
}

const baseValidatorOptions = {
  recordType: 'bib',
  sruUrl: 'http://sru.example',
  preValidationFixOptions: {},
  preImportFixOptions: {},
  matchOptionsList: [{matchPackageName: 'TESTMATCHER'}],
  stopWhenFound: true,
  acceptZeroWithMaxCandidates: true,
  matchFailuresAsNew: false,
  logOptions: {logInputRecord: true, logNoMatches: true, logResultRecord: true}
};

// Starts the poll loop with fakes. The promise never resolves on its own:
// every test waits for an observable final condition (onEvent), asserts on
// fake state, then calls stop() and drains the loop via assert.rejects.
// The rejection is swallowed here too, so a test that fails before stop()
// never leaves an unhandled rejection behind.
async function runApp({
  pollRequest,
  queueItems = [],
  streams = {},
  freshStates = {},
  sruClient = makeSruClient(),
  matchers = [async () => matchResult()],
  splitterOptions = {failBulkOnError: false, keepSplitterReport: 'NONE'}
}) {
  const amqpOperator = makeAmqpOperator();
  const mongoOperator = makeMongoOperator({queueItems, streams, freshStates});
  const mongoLogOperator = makeLogOperator();
  const promise = startApp({
    pollRequest,
    pollWaitTime: 1,
    amqpUrl: 'amqp://unused',
    mongoUri: 'mongodb://unused',
    validatorOptions: baseValidatorOptions,
    splitterOptions,
    recordType: 'bib',
    deps: {mongoOperator, amqpOperator, mongoLogOperator, sruClient, matchers}
  });
  promise.catch(() => {/* the loop is stopped on purpose in every test */});
  // Stop both operators: in prio mode the drain rejection comes from checkQueue
  // (and surfaces as the outermost frame's rejection), in bulk mode from getOne
  const drain = () => {
    amqpOperator.stop();
    mongoOperator.stop();
    return assert.rejects(promise, /STOP/u);
  };
  return {promise, amqpOperator, mongoOperator, mongoLogOperator, drain};
}

describe('prio mode (valid results)', () => {
  it('Should route a merge changed CREATE to the UPDATE queue and set import states', async () => {
    const record = fixture('01-single-valid', 'record.json');
    const candidate = new MarcRecord(fixture('01-single-valid', 'candidates.json')[0].record, {subfieldValues: false});
    const sruClient = makeSruClient({cand1: candidate});
    const matchers = [async () => matchResult({
      matches: [{candidate: {id: 'cand1', record: candidate}, probability: 100}],
      candidateCount: 1
    })];
    const {amqpOperator, mongoOperator, mongoLogOperator, drain} = await runApp({
      pollRequest: true,
      queueItems: [{correlationId: 'corr1', state: 'PENDING_VALIDATION', operationSettings: {}}],
      sruClient,
      matchers
    });
    const headers = makePrioHeaders({operation: 'CREATE'}, {validate: false, unique: true, merge: true});
    amqpOperator.seedMessage('REQUESTS', makePrioMessage({correlationId: 'corr1', headers, data: record}));

    await amqpOperator.onEvent('send', 'UPDATE.corr1');
    // stop() in the finally: a failed assertion must never leave the loop spinning
    try {
    const queueItem = mongoOperator.items.get('corr1');
    assert.deepStrictEqual(queueItem.stateLog.map(({state}) => state), ['VALIDATING', 'IN_QUEUE']);
    assert.deepStrictEqual(queueItem.importJobs, [{operation: 'UPDATE', importJobState: 'IN_QUEUE', checked: true}]);
    assert.deepStrictEqual(queueItem.operations, [
      {addOperation: 'UPDATE', removeOperation: undefined},
      {addOperation: 'UPDATE', removeOperation: 'CREATE'}
    ]);
    assert.equal(amqpOperator.state.acked.length, 1);
    assert.deepStrictEqual(amqpOperator.state.sent.map(({queue}) => queue), ['UPDATE.corr1']);
    const sent = amqpOperator.state.sent[0];
    assert.equal(sent.headers.operation, 'UPDATE');
    assert.equal(sent.headers.id, 'cand1');
    const resultLog = mongoLogOperator.state.logItems.find(({logItemType}) => logItemType === 'RESULT_RECORD_LOG');
    assert.ok(resultLog);
    assert.equal(resultLog.blobSequence, 1);

    await drain(amqpOperator);
    } finally {
      amqpOperator.stop();
    }
  });

  it('Should push noop and skipped response items without sending to operation queues', async () => {
    const existing = {leader: LEADER, fields: [
      {tag: '001', value: '000020001'},
      titleField('foo.'),
      {tag: '003', value: 'FI-MELINDA'},
      catField('u1 20240101120000')
    ]};
    const {amqpOperator, mongoOperator, mongoLogOperator, drain} = await runApp({
      pollRequest: true,
      queueItems: [
        {correlationId: 'corr1', state: 'PENDING_VALIDATION', operationSettings: {}},
        {correlationId: 'corr2', state: 'PENDING_VALIDATION', operationSettings: {}}
      ],
      sruClient: makeSruClient({'000020001': existing})
    });
    amqpOperator.seedMessage('REQUESTS', makePrioMessage({
      correlationId: 'corr1',
      headers: makePrioHeaders({}, {validate: false, unique: false, merge: false, noop: true}),
      data: {leader: LEADER, fields: [titleField('foo.')]}
    }));
    amqpOperator.seedMessage('REQUESTS', makePrioMessage({
      correlationId: 'corr2',
      headers: makePrioHeaders(
        {operation: 'UPDATE', id: '000020001', recordMetadata: {blobSequence: 2}},
        {validate: true, unique: false, merge: false, skipNoChangeUpdates: true}
      ),
      data: existing
    }));
    const settled = amqpOperator.onEvent('ack', 'corr2');
    await settled;
    // stop() in the finally: a failed assertion must never leave the loop spinning
    try {

    const noopResponse = mongoOperator.items.get('corr1').recordResponses[0];
    assert.equal(noopResponse.recordStatus, 'CREATED');
    assert.equal(noopResponse.detailedRecordStatus, 'CREATED');
    assert.equal(noopResponse.databaseId, '000000000');
    assert.equal(noopResponse.message, 'Would create a new record. - Noop.');
    const skipResponse = mongoOperator.items.get('corr2').recordResponses[0];
    assert.equal(skipResponse.recordStatus, 'SKIPPED');
    assert.equal(skipResponse.detailedRecordStatus, 'SKIPPED_CHANGE');
    assert.equal(skipResponse.databaseId, '000020001');
    assert.match(skipResponse.message, /^No changes detected while trying to update existing record 000020001/u);
    // skipped records lose their log items
    assert.deepStrictEqual(mongoLogOperator.state.removed, [{correlationId: 'corr2', sequences: [2]}]);
    // both queueItems end DONE, nothing was sent to operation queues
    assert.deepStrictEqual(mongoOperator.items.get('corr1').stateLog.map(({state}) => state), ['VALIDATING', 'DONE']);
    assert.deepStrictEqual(mongoOperator.items.get('corr2').stateLog.map(({state}) => state), ['VALIDATING', 'DONE']);
    assert.deepStrictEqual(amqpOperator.state.sent, []);
    assert.equal(amqpOperator.state.acked.length, 2);

    await drain(amqpOperator);
    } finally {
      amqpOperator.stop();
    }
  });
  it('Should answer a noop skipped UPDATE with a Noop response item', async () => {
    const existing = {leader: LEADER, fields: [
      {tag: '001', value: '000020001'},
      titleField('foo.'),
      {tag: '003', value: 'FI-MELINDA'},
      catField('u1 20240101120000')
    ]};
    const {amqpOperator, mongoOperator, drain} = await runApp({
      pollRequest: true,
      queueItems: [{correlationId: 'corr1', state: 'PENDING_VALIDATION', operationSettings: {}}],
      sruClient: makeSruClient({'000020001': existing})
    });
    amqpOperator.seedMessage('REQUESTS', makePrioMessage({
      correlationId: 'corr1',
      headers: makePrioHeaders(
        {operation: 'UPDATE', id: '000020001', recordMetadata: {blobSequence: 2}, notes: ['skip note']},
        {validate: true, unique: false, merge: false, skipNoChangeUpdates: true, noop: true}
      ),
      data: existing
    }));

    await amqpOperator.onEvent('ack', 'corr1');
    // stop() in the finally: a failed assertion must never leave the loop spinning
    try {
      const response = mongoOperator.items.get('corr1').recordResponses[0];
      assert.equal(response.recordStatus, 'SKIPPED');
      assert.equal(response.detailedRecordStatus, 'SKIPPED_CHANGE');
      assert.equal(response.databaseId, '000020001');
      // the header note and the forced skip note are joined, and the
      // noop: true branch appends the Noop suffix
      assert.equal(response.message,
        'skip note - No changes detected while trying to update existing record 000020001, update skipped. - Noop.');
      assert.deepStrictEqual(mongoOperator.items.get('corr1').stateLog.map(({state}) => state), ['VALIDATING', 'DONE']);
      assert.deepStrictEqual(amqpOperator.state.sent, []);

      await drain(amqpOperator);
    } finally {
      amqpOperator.stop();
    }
  });

  it('Should answer a non-array-notes skip with an empty message (defensive branch)', async () => {
    // A truly notes-free skip is unreachable through the real facade: both
    // skip paths in validations.js force at least one note into
    // headers.notes. The only way to make setSkipResult's notesString be ''
    // is a non-array notes header: 'foo'.concat(skipNote) stays a string, so
    // the defensive Array.isArray(notes) check fails and notesString is ''.
    // This test intentionally exercises that defensive non-array branch:
    // the real skip paths always supply a notes array, but the fallback
    // must stay covered regardless.
    const existing = {leader: LEADER, fields: [
      {tag: '001', value: '000020001'},
      titleField('foo.'),
      {tag: '003', value: 'FI-MELINDA'},
      catField('u1 20240101120000')
    ]};
    const {amqpOperator, mongoOperator, drain} = await runApp({
      pollRequest: true,
      queueItems: [{correlationId: 'corr1', state: 'PENDING_VALIDATION', operationSettings: {}}],
      sruClient: makeSruClient({'000020001': existing})
    });
    amqpOperator.seedMessage('REQUESTS', makePrioMessage({
      correlationId: 'corr1',
      headers: makePrioHeaders(
        {operation: 'UPDATE', id: '000020001', recordMetadata: {blobSequence: 2}, notes: 'foo'},
        {validate: true, unique: false, merge: false, skipNoChangeUpdates: true}
      ),
      data: existing
    }));

    await amqpOperator.onEvent('ack', 'corr1');
    // stop() in the finally: a failed assertion must never leave the loop spinning
    try {
      const response = mongoOperator.items.get('corr1').recordResponses[0];
      assert.equal(response.detailedRecordStatus, 'SKIPPED_CHANGE');
      assert.equal(response.message, '');
      assert.deepStrictEqual(mongoOperator.items.get('corr1').stateLog.map(({state}) => state), ['VALIDATING', 'DONE']);
      assert.deepStrictEqual(amqpOperator.state.sent, []);

      await drain(amqpOperator);
    } finally {
      amqpOperator.stop();
    }
  });

  it('Should route a FIX result to the FIX queue and push noop fixes as response items', async () => {
    const existing = {leader: LEADER, fields: [
      {tag: '001', value: '000019640'},
      titleField('foo.')
    ]};
    const {amqpOperator, mongoOperator, drain} = await runApp({
      pollRequest: true,
      queueItems: [{correlationId: 'corr1', state: 'PENDING_VALIDATION', operationSettings: {}}],
      sruClient: makeSruClient({'000019640': existing})
    });
    const fixHeaders = (settings) => ({
      correlationId: 'corr1',
      operation: 'FIX',
      id: '000019640',
      cataloger: {id: 'u1'},
      recordMetadata: {blobSequence: 1},
      operationSettings: {fixType: 'FIX', validate: true, ...settings}
    });
    amqpOperator.seedMessage('REQUESTS', makePrioMessage({
      correlationId: 'corr1', headers: fixHeaders({noop: false})
    }));
    amqpOperator.seedMessage('REQUESTS', makePrioMessage({
      correlationId: 'corr1', headers: fixHeaders({fixType: 'REINDEX', noop: true})
    }));
    const settled = amqpOperator.onEvent('ack', 'corr1', 2);

    await settled;
    // stop() in the finally: a failed assertion must never leave the loop spinning
    try {
    const queueItem = mongoOperator.items.get('corr1');
    assert.deepStrictEqual(queueItem.stateLog.map(({state}) => state), ['VALIDATING', 'IN_QUEUE', 'VALIDATING', 'DONE']);
    assert.deepStrictEqual(queueItem.importJobs, [{operation: 'FIX', importJobState: 'IN_QUEUE', checked: true}]);
    assert.deepStrictEqual(amqpOperator.state.sent.map(({queue}) => queue), ['FIX.corr1']);
    const noopFix = queueItem.recordResponses[0];
    assert.equal(noopFix.recordStatus, 'FIXED');
    assert.equal(noopFix.message, 'Would fix (REINDEX) record 000019640. - Noop.');
    assert.equal(noopFix.databaseId, '000019640');

    await drain(amqpOperator);
    } finally {
      amqpOperator.stop();
    }
  });

  it('Should push a notes-carrying noop FIX result to a response item', async () => {
    const existing = {leader: LEADER, fields: [
      {tag: '001', value: '000019640'},
      titleField('foo.')
    ]};
    const {amqpOperator, mongoOperator, drain} = await runApp({
      pollRequest: true,
      queueItems: [{correlationId: 'corr1', state: 'PENDING_VALIDATION', operationSettings: {}}],
      sruClient: makeSruClient({'000019640': existing})
    });
    amqpOperator.seedMessage('REQUESTS', makePrioMessage({
      correlationId: 'corr1',
      headers: {
        correlationId: 'corr1',
        operation: 'FIX',
        id: '000019640',
        cataloger: {id: 'u1'},
        recordMetadata: {blobSequence: 1},
        notes: ['fix note'],
        operationSettings: {fixType: 'REINDEX', validate: true, noop: true}
      }
    }));

    await amqpOperator.onEvent('ack', 'corr1');
    // stop() in the finally: a failed assertion must never leave the loop spinning
    try {
      const queueItem = mongoOperator.items.get('corr1');
      assert.deepStrictEqual(queueItem.stateLog.map(({state}) => state), ['VALIDATING', 'DONE']);
      const noopFix = queueItem.recordResponses[0];
      assert.equal(noopFix.recordStatus, 'FIXED');
      assert.equal(noopFix.databaseId, '000019640');
      assert.equal(noopFix.message, 'fix note - Would fix (REINDEX) record 000019640. - Noop.');
      assert.deepStrictEqual(amqpOperator.state.sent, []);

      await drain(amqpOperator);
    } finally {
      amqpOperator.stop();
    }
  });
});

describe('prio mode (stale items and errors)', () => {
  const seedUpdateMessage = (amqpOperator, {correlationId = 'corr1', id = '000020001', blobSequence = 1, settings = {}}) => {
    const headers = makePrioHeaders(
      {operation: 'UPDATE', id, recordMetadata: {blobSequence}, correlationId},
      {validate: false, unique: false, merge: false, ...settings}
    );
    amqpOperator.seedMessage('REQUESTS', makePrioMessage({
      correlationId, headers,
      data: {leader: LEADER, fields: [
        {tag: '001', value: id},
        titleField('baz.'),
        catField('u1 20240101120000')
      ]}
    }));
  };

  it('Should ack and drop a stale queueItem without validating or answering', async () => {
    const {amqpOperator, mongoOperator, mongoLogOperator, drain} = await runApp({
      pollRequest: true,
      queueItems: [{correlationId: 'corr1', state: 'PENDING_VALIDATION', operationSettings: {}}],
      freshStates: {corr1: [false]},
      sruClient: makeSruClient({'000020001': {leader: LEADER, fields: []}})
    });
    seedUpdateMessage(amqpOperator, {});

    await mongoOperator.onEvent('state', 'ABORT');
    try {
      const queueItem = mongoOperator.items.get('corr1');
      assert.deepStrictEqual(queueItem.stateLog.map(({state}) => state), ['ABORT']);
      assert.deepStrictEqual(queueItem.recordResponses, []);
      assert.deepStrictEqual(amqpOperator.state.sent, []);
      assert.equal(amqpOperator.state.acked.length, 1);
      assert.deepStrictEqual(mongoLogOperator.state.logItems, []);

      await drain(amqpOperator);
    } finally {
      amqpOperator.stop();
    }
  });

  it('Should answer an ApiError with its status and payload and mark the queueItem ERROR', async () => {
    const {amqpOperator, mongoOperator, drain} = await runApp({
      pollRequest: true,
      queueItems: [{correlationId: 'corr1', state: 'PENDING_VALIDATION', operationSettings: {}}],
      sruClient: makeSruClient() // record 000020001 not found -> 404
    });
    // validate: true so the facade actually runs updateValidations (and the SRU fetch)
    seedUpdateMessage(amqpOperator, {settings: {validate: true}});

    await mongoOperator.onEvent('state', 'ERROR');
    try {
      const queueItem = mongoOperator.items.get('corr1');
      const errorState = queueItem.stateLog[queueItem.stateLog.length - 1];
      assert.equal(errorState.state, 'ERROR');
      assert.equal(errorState.errorStatus, 404);
      const response = queueItem.recordResponses[0];
      assert.equal(response.detailedRecordStatus, 'NOT_FOUND');
      assert.equal(response.message, 'Cannot find record 000020001 to update');
      // the recordMetadata comes from the error payload the facade wraps
      assert.equal(response.recordMetadata.blobSequence, 1);
      assert.equal(response.databaseId, '000020001');
      assert.equal(amqpOperator.state.acked.length, 1);

      await drain(amqpOperator);
    } finally {
      amqpOperator.stop();
    }
  });

  it('Should answer an error without payload with 500 and the message headers metadata', async () => {
    const {amqpOperator, mongoOperator, drain} = await runApp({
      pollRequest: true,
      queueItems: [{correlationId: 'corr1', state: 'PENDING_VALIDATION', operationSettings: {}}],
      sruClient: makeSruClient({'000020001': new Error('SRU is down')})
    });
    seedUpdateMessage(amqpOperator, {settings: {validate: true}});

    await mongoOperator.onEvent('state', 'ERROR');
    try {
      const queueItem = mongoOperator.items.get('corr1');
      const errorState = queueItem.stateLog[queueItem.stateLog.length - 1];
      assert.equal(errorState.state, 'ERROR');
      assert.equal(errorState.errorStatus, 500);
      const response = queueItem.recordResponses[0];
      // 500 is not mapped to a status name by the commons, it stays numeric
      assert.equal(response.detailedRecordStatus, 500);
      // the facade rethrows the original plain Error (no status/payload), so the
      // surfaced message is the original error's message (status stays 500, which
      // commons does not map, so it appends the unknown-status suffix)
      assert.equal(response.message, 'SRU is down - Unknown recordStatus: 500');
      // no recordMetadata in the payload -> the message headers metadata is used
      assert.equal(response.recordMetadata.blobSequence, 1);
      assert.equal(response.databaseId, '000020001');

      await drain(amqpOperator);
    } finally {
      amqpOperator.stop();
    }
  });

  it('Should answer a 500 error with undefined recordMetadata when neither headers nor payload carry it', async () => {
    const {amqpOperator, mongoOperator, drain} = await runApp({
      pollRequest: true,
      queueItems: [{correlationId: 'corr1', state: 'PENDING_VALIDATION', operationSettings: {}}],
      sruClient: makeSruClient({'000020001': new Error('SRU is down')})
    });
    // headers deliberately omit recordMetadata; the facade rethrows the plain
    // SRU error as-is, so the payload (built from error.message) has no
    // recordMetadata either
    const headers = makePrioHeaders(
      {operation: 'UPDATE', id: '000020001', recordMetadata: undefined},
      {validate: true, unique: false, merge: false}
    );
    amqpOperator.seedMessage('REQUESTS', makePrioMessage({
      correlationId: 'corr1', headers,
      data: {leader: LEADER, fields: [
        {tag: '001', value: '000020001'},
        titleField('baz.'),
        catField('u1 20240101120000')
      ]}
    }));

    await mongoOperator.onEvent('state', 'ERROR');
    try {
      const queueItem = mongoOperator.items.get('corr1');
      const errorState = queueItem.stateLog[queueItem.stateLog.length - 1];
      assert.equal(errorState.state, 'ERROR');
      assert.equal(errorState.errorStatus, 500);
      const response = queueItem.recordResponses[0];
      assert.equal(response.message, 'SRU is down - Unknown recordStatus: 500');
      // neither the message headers nor the error payload carry
      // recordMetadata, so the response has none either
      assert.strictEqual(response.recordMetadata, undefined);
      assert.equal(response.databaseId, '000020001');
      assert.equal(amqpOperator.state.acked.length, 1);

      await drain(amqpOperator);
    } finally {
      amqpOperator.stop();
    }
  });

  it('Should crash on an amqp error when no message is being processed', async () => {
    // BUG (pinned, not fixed): the "logError + retry on ApiError without
    // message" branch of checkAmqpForRequests is unreachable - checkQueue is
    // called OUTSIDE the try block, and the initCheck recursion is returned
    // without await, so a checkQueue rejection propagates straight up and the
    // app rejects with the original error (no retry, not even for ApiErrors)
    const {promise, amqpOperator} = await runApp({pollRequest: true});
    try {
      amqpOperator.failNextCheckQueueWith(new ApiError(503, {message: 'Channel wobble'}));

      await assert.rejects(promise, (err) => {
        assert.equal(err.status, 503);
        assert.deepStrictEqual(err.payload, {message: 'Channel wobble'});
        return true;
      });
      // no retry happened: the failing call was the only poll that ever ran
      assert.equal(amqpOperator.state.checkAttempts.filter((q) => q === 'REQUESTS').length, 1);
    } finally {
      amqpOperator.stop();
    }
  });

  it('Should answer noop UPDATEs and notes-carrying noop results with response items', async () => {
    const {amqpOperator, mongoOperator, mongoLogOperator, drain} = await runApp({
      pollRequest: true,
      queueItems: [
        {correlationId: 'corr1', state: 'PENDING_VALIDATION', operationSettings: {}},
        {correlationId: 'corr2', state: 'PENDING_VALIDATION', operationSettings: {}}
      ]
    });
    const updateData = {leader: LEADER, fields: [
      {tag: '001', value: '000020001'},
      titleField('baz.'),
      catField('u1 20240101120000')
    ]};
    amqpOperator.seedMessage('REQUESTS', makePrioMessage({
      correlationId: 'corr1',
      headers: makePrioHeaders({notes: ['first note']}, {validate: false, unique: false, merge: false, noop: true}),
      data: {leader: LEADER, fields: [titleField('foo.')]}
    }));
    amqpOperator.seedMessage('REQUESTS', makePrioMessage({
      correlationId: 'corr2',
      headers: makePrioHeaders(
        {operation: 'UPDATE', id: '000020001', recordMetadata: {blobSequence: 2}, notes: ['u1 note']},
        {validate: false, unique: false, merge: false, noop: true}
      ),
      data: updateData
    }));

    await amqpOperator.onEvent('ack', 'corr2');
    try {
      const responses = [
        mongoOperator.items.get('corr1').recordResponses[0],
        mongoOperator.items.get('corr2').recordResponses[0]
      ];
      assert.deepStrictEqual(responses.map(({detailedRecordStatus}) => detailedRecordStatus), ['CREATED', 'UPDATED']);
      assert.equal(responses[0].message, 'first note - Would create a new record. - Noop.');
      assert.equal(responses[1].message, 'u1 note - Would update record 000020001. - Noop.');
      assert.equal(responses[1].databaseId, '000020001');
      // noop results with notes do not lose the log items: input and result
      // record logs exist for both messages and nothing was removed
      assert.deepStrictEqual(
        mongoLogOperator.state.logItems.map(({logItemType, blobSequence}) => `${logItemType}:${blobSequence}`).sort(),
        ['INPUT_RECORD_LOG:1', 'INPUT_RECORD_LOG:2', 'RESULT_RECORD_LOG:1', 'RESULT_RECORD_LOG:2']
      );
      assert.deepStrictEqual(mongoLogOperator.state.removed, []);
      assert.deepStrictEqual(amqpOperator.state.sent, []);

      await drain(amqpOperator);
    } finally {
      amqpOperator.stop();
    }
  });
});

const bulkRecord = () => ({leader: LEADER, fields: [titleField('foo.')]});

const jsonStream = (payload) => Readable.from([JSON.stringify(payload)]);

function makeBulkItem(correlationId, state, settings, overrides = {}) {
  return {
    correlationId,
    state,
    operation: 'CREATE',
    contentType: 'application/json',
    cataloger: {id: 'u1'},
    operationSettings: {validate: false, noop: false, ...settings},
    ...overrides
  };
}

describe('bulk mode (stream to records and validation)', () => {
  it('Should split a PENDING_QUEUING stream, validate the records and drain the job to IN_QUEUE', async () => {
    const correlationId = 'corrB1';
    const {amqpOperator, mongoOperator, mongoLogOperator, drain} = await runApp({
      pollRequest: false,
      queueItems: [makeBulkItem(correlationId, 'PENDING_QUEUING', {validate: true})],
      streams: {[correlationId]: jsonStream([bulkRecord(), bulkRecord()])}
    });

    await mongoOperator.onEvent('state', 'IN_QUEUE');
    try {
      const queueItem = mongoOperator.items.get(correlationId);
      // note: bulk messages skip checkAndSetState (they are always "fresh"),
      // so VALIDATING is set once by checkMongo when the job becomes pending
      assert.deepStrictEqual(queueItem.stateLog.map(({state}) => state), [
        'QUEUING_IN_PROGRESS', 'PENDING_VALIDATION', 'VALIDATING', 'IN_QUEUE'
      ]);
      // the splitter published both records to the validation queue, the
      // validator results went to the operation queue, and the import jobs
      // were marked IN_QUEUE without touching the queueItem state
      assert.deepStrictEqual(amqpOperator.state.sent.map(({queue}) => queue), [
        'PENDING_VALIDATION.corrB1', 'PENDING_VALIDATION.corrB1',
        'CREATE.corrB1', 'CREATE.corrB1'
      ]);
      assert.deepStrictEqual(amqpOperator.state.sent.map(({headers: {id}}) => id), [
        '000000001', '000000002', '000000001', '000000002'
      ]);
      assert.deepStrictEqual(queueItem.importJobs, [
        {operation: 'CREATE', importJobState: 'IN_QUEUE', checked: false},
        {operation: 'CREATE', importJobState: 'IN_QUEUE', checked: false}
      ]);
      assert.deepStrictEqual(amqpOperator.state.removed, [`PENDING_VALIDATION.${correlationId}`]);
      assert.deepStrictEqual(queueItem.blobSizes, [2]);
      assert.ok(mongoLogOperator.state.logItems.some(({logItemType}) => logItemType === 'SPLITTER_LOG'));

      await drain();
    } finally {
      amqpOperator.stop();
      mongoOperator.stop();
    }
  });

  it('Should mark a non-validated bulk job IN_QUEUE for the importer after splitting', async () => {
    const correlationId = 'corrB2';
    const {amqpOperator, mongoOperator, drain} = await runApp({
      pollRequest: false,
      queueItems: [makeBulkItem(correlationId, 'PENDING_QUEUING', {validate: false})],
      streams: {[correlationId]: jsonStream([bulkRecord()])}
    });

    await mongoOperator.onEvent('state', 'IN_QUEUE');
    try {
      const queueItem = mongoOperator.items.get(correlationId);
      assert.deepStrictEqual(queueItem.stateLog.map(({state}) => state), ['QUEUING_IN_PROGRESS', 'IN_QUEUE']);
      // without validation the splitter sends straight to the operation queue
      assert.deepStrictEqual(amqpOperator.state.sent.map(({queue}) => queue), ['CREATE.corrB2']);
      assert.deepStrictEqual(queueItem.importJobs, [{operation: 'CREATE', importJobState: 'IN_QUEUE', checked: false}]);
      assert.deepStrictEqual(amqpOperator.state.removed, []);

      await drain();
    } finally {
      amqpOperator.stop();
      mongoOperator.stop();
    }
  });

  it('Should finish a noop non-validated bulk job with DONE and per-record responses', async () => {
    const correlationId = 'corrB3';
    const {amqpOperator, mongoOperator, drain} = await runApp({
      pollRequest: false,
      queueItems: [makeBulkItem(correlationId, 'PENDING_QUEUING', {validate: false, noop: true})],
      streams: {[correlationId]: jsonStream([bulkRecord()])}
    });

    await mongoOperator.onEvent('state', 'DONE');
    try {
      const queueItem = mongoOperator.items.get(correlationId);
      assert.deepStrictEqual(queueItem.stateLog.map(({state}) => state), ['QUEUING_IN_PROGRESS', 'DONE']);
      // noop records without validation do not go to any queue
      assert.deepStrictEqual(amqpOperator.state.sent, []);
      const response = queueItem.recordResponses[0];
      assert.equal(response.recordStatus, 'CREATED');
      assert.equal(response.message, 'Record read from stream. Noop.');
      assert.equal(response.databaseId, '000000000');

      await drain();
    } finally {
      amqpOperator.stop();
      mongoOperator.stop();
    }
  });

  it('Should mark the bulk job ERROR with the splitter ApiError when FAIL_BULK_ON_ERROR applies', async () => {
    const correlationId = 'corrB4';
    const {amqpOperator, mongoOperator, mongoLogOperator, drain} = await runApp({
      pollRequest: false,
      queueItems: [makeBulkItem(correlationId, 'PENDING_QUEUING', {validate: false, failOnError: true})],
      streams: {[correlationId]: jsonStream([bulkRecord(), 'not-a-record'])}
    });

    const removed = amqpOperator.onEvent('remove', `CREATE.${correlationId}`);
    await mongoOperator.onEvent('state', 'ERROR');
    try {
      const queueItem = mongoOperator.items.get(correlationId);
      const errorState = queueItem.stateLog[1];
      assert.equal(errorState.state, 'ERROR');
      assert.equal(errorState.errorStatus, 422);
      const response = queueItem.recordResponses[0];
      assert.equal(response.detailedRecordStatus, 'UNPROCESSABLE_ENTITY');
      // keepSplitterReport NONE: the splitter report is only logged, not stored
      assert.deepStrictEqual(queueItem.splitterReports, []);
      assert.ok(mongoLogOperator.state.logItems.some(({logItemType}) => logItemType === 'SPLITTER_LOG'));
      // the reader 'end' handler finishes ~500 ms later and removes the queue
      await removed;
      assert.deepStrictEqual(amqpOperator.state.removed, [`CREATE.${correlationId}`]);

      await drain();
    } finally {
      amqpOperator.stop();
      mongoOperator.stop();
    }
  });

  it('Should answer a failing bulk validation record, keep draining and end IN_QUEUE', async () => {
    const correlationId = 'corrB5';
    const {amqpOperator, mongoOperator, drain} = await runApp({
      pollRequest: false,
      queueItems: [makeBulkItem(correlationId, 'VALIDATING', {validate: false, noop: false})]
    });
    amqpOperator.seedMessage(`PENDING_VALIDATION.${correlationId}`, makePrioMessage({
      correlationId,
      headers: {
        correlationId,
        operation: 'CREATE',
        cataloger: {id: 'u1'},
        recordMetadata: {blobSequence: 1},
        id: '000000001',
        operationSettings: {validate: true}
      },
      // 003 is not FI-MELINDA -> validationService fails with 422
      data: {leader: LEADER, fields: [{tag: '003', value: 'FI-OTHER'}, titleField('foo.')]}
    }));

    await mongoOperator.onEvent('state', 'IN_QUEUE');
    try {
      const queueItem = mongoOperator.items.get(correlationId);
      const response = queueItem.recordResponses[0];
      assert.equal(response.detailedRecordStatus, 'UNPROCESSABLE_ENTITY');
      assert.ok(Array.isArray(response.message));
      // a bulk validation error is answered but does not change the queueItem
      // state; the job keeps draining the (now empty) validation queue
      assert.deepStrictEqual(queueItem.stateLog.map(({state}) => state), ['IN_QUEUE']);
      assert.deepStrictEqual(amqpOperator.state.removed, [`PENDING_VALIDATION.${correlationId}`]);
      assert.equal(amqpOperator.state.acked.length, 1);

      await drain();
    } finally {
      amqpOperator.stop();
      mongoOperator.stop();
    }
  });

  it('Should mark a noop bulk job DONE when its validation queue is empty', async () => {
    const correlationId = 'corrB6';
    const {amqpOperator, mongoOperator, drain} = await runApp({
      pollRequest: false,
      queueItems: [makeBulkItem(correlationId, 'VALIDATING', {validate: true, noop: true})]
    });

    await mongoOperator.onEvent('state', 'DONE');
    try {
      assert.deepStrictEqual(mongoOperator.items.get(correlationId).stateLog.map(({state}) => state), ['DONE']);

      await drain();
    } finally {
      amqpOperator.stop();
      mongoOperator.stop();
    }
  });

  it('Should update the queueItem operation when bulk validation changes it to UPDATE', async () => {
    const correlationId = 'corrB7';
    const record = fixture('01-single-valid', 'record.json');
    const candidate = new MarcRecord(fixture('01-single-valid', 'candidates.json')[0].record, {subfieldValues: false});
    const sruClient = makeSruClient({cand1: candidate});
    const matchers = [async () => matchResult({
      matches: [{candidate: {id: 'cand1', record: candidate}, probability: 100}],
      candidateCount: 1
    })];
    const {amqpOperator, mongoOperator, drain} = await runApp({
      pollRequest: false,
      queueItems: [makeBulkItem(correlationId, 'VALIDATING', {validate: false, noop: false})],
      sruClient,
      matchers
    });
    amqpOperator.seedMessage(`PENDING_VALIDATION.${correlationId}`, makePrioMessage({
      correlationId,
      headers: {
        correlationId,
        operation: 'CREATE',
        cataloger: {id: 'u1'},
        recordMetadata: {blobSequence: 1},
        operationSettings: {validate: false, unique: true, merge: true}
      },
      data: record
    }));

    await mongoOperator.onEvent('state', 'IN_QUEUE');
    try {
      const queueItem = mongoOperator.items.get(correlationId);
      // the merge changed the operation CREATE -> UPDATE and bulk only adds
      // the new operation to the queueItem
      assert.deepStrictEqual(queueItem.operations, [{addOperation: 'UPDATE', removeOperation: undefined}]);
      assert.deepStrictEqual(amqpOperator.state.sent.map(({queue}) => queue), ['UPDATE.corrB7']);
      assert.deepStrictEqual(amqpOperator.state.sent[0].headers.id, 'cand1');
      assert.deepStrictEqual(queueItem.stateLog.map(({state}) => state), ['IN_QUEUE']);
      assert.deepStrictEqual(queueItem.importJobs, [{operation: 'UPDATE', importJobState: 'IN_QUEUE', checked: false}]);

      await drain();
    } finally {
      amqpOperator.stop();
      mongoOperator.stop();
    }
  });

  it('Should route bulk skip, noop load and noop fix results to response items only', async () => {
    const correlationId = 'corrB8';
    const existing = {leader: LEADER, fields: [
      {tag: '001', value: '000020001'},
      titleField('foo.'),
      {tag: '003', value: 'FI-MELINDA'},
      catField('u1 20240101120000')
    ]};
    const sruClient = makeSruClient({
      '000020001': existing,
      '000019640': {leader: LEADER, fields: [{tag: '001', value: '000019640'}, titleField('foo.')]}
    });
    const {amqpOperator, mongoOperator, mongoLogOperator, drain} = await runApp({
      pollRequest: false,
      queueItems: [makeBulkItem(correlationId, 'VALIDATING', {validate: false, noop: false})],
      sruClient
    });
    const seed = (headers, data) => amqpOperator.seedMessage(`PENDING_VALIDATION.${correlationId}`,
      makePrioMessage({correlationId, headers, data}));
    seed({
      correlationId, operation: 'UPDATE', id: '000020001', cataloger: {id: 'u1'},
      recordMetadata: {blobSequence: 1},
      operationSettings: {validate: true, unique: false, merge: false, skipNoChangeUpdates: true}
    }, existing);
    seed({
      correlationId, operation: 'CREATE', cataloger: {id: 'u1'},
      recordMetadata: {blobSequence: 2},
      operationSettings: {validate: false, unique: false, merge: false, noop: true}
    }, {leader: LEADER, fields: [titleField('foo.')]});
    seed({
      correlationId, operation: 'FIX', id: '000019640', cataloger: {id: 'u1'},
      recordMetadata: {blobSequence: 3},
      operationSettings: {fixType: 'REINDEX', validate: true, noop: true}
    });

    await mongoOperator.onEvent('state', 'IN_QUEUE');
    try {
      const queueItem = mongoOperator.items.get(correlationId);
      const responses = queueItem.recordResponses;
      assert.deepStrictEqual(responses.map(({detailedRecordStatus}) => detailedRecordStatus),
        ['SKIPPED_CHANGE', 'CREATED', 'FIXED']);
      assert.equal(responses[0].databaseId, '000020001');
      assert.equal(responses[1].databaseId, '000000000');
      assert.equal(responses[2].message, 'Would fix (REINDEX) record 000019640. - Noop.');
      // bulk results end in IN_QUEUE (not DONE) and nothing went to operation queues
      assert.deepStrictEqual(queueItem.stateLog.map(({state}) => state), ['IN_QUEUE']);
      assert.deepStrictEqual(amqpOperator.state.sent, []);
      assert.deepStrictEqual(amqpOperator.state.removed, [`PENDING_VALIDATION.${correlationId}`]);
      // skipped records lose their log items, bulk included
      assert.deepStrictEqual(mongoLogOperator.state.removed, [{correlationId, sequences: [1]}]);

      await drain();
    } finally {
      amqpOperator.stop();
      mongoOperator.stop();
    }
  });

  it('Should mark the item ERROR when the bulk stream errors with a non-ApiError, then crash', async () => {
    // a non-ApiError from streamToRecords is logged, the queueItem is marked
    // ERROR (best effort) with the error info, and the ORIGINAL error is
    // rethrown so the app dies - the item is no longer left stuck in
    // QUEUING_IN_PROGRESS across a restart
    const correlationId = 'corrB9';
    const {promise, amqpOperator, mongoOperator} = await runApp({
      pollRequest: false,
      queueItems: [makeBulkItem(correlationId, 'PENDING_QUEUING', {validate: false, noop: false},
        {contentType: 'application/alephseq'})],
      // not a stream: the reader constructor throws a TypeError
      streams: {[correlationId]: {}}
    });

    try {
      await assert.rejects(promise, (err) => {
        assert(err instanceof TypeError);
        assert.equal(err.message, 'stream.on is not a function');
        return true;
      });
      const queueItem = mongoOperator.items.get(correlationId);
      assert.deepStrictEqual(queueItem.stateLog.map(({state}) => state), ['QUEUING_IN_PROGRESS', 'ERROR']);
      const errorState = queueItem.stateLog[1];
      assert.deepStrictEqual(errorState.errorMessage, {message: 'stream.on is not a function'});
      // a TypeError has no status: 500 is recorded
      assert.equal(errorState.errorStatus, 500);
    } finally {
      amqpOperator.stop();
      mongoOperator.stop();
    }
  });

  it('Should error a stale QUEUING_IN_PROGRESS item on restart without reprocessing it', async () => {
    // a crashed/restarted previous worker leaves the item stuck in
    // QUEUING_IN_PROGRESS; a fresh process must error it out on its first
    // poll instead of re-splitting (a half-split bulk job could double-write
    // record items)
    const correlationId = 'corrB10';
    const {amqpOperator, mongoOperator, drain} = await runApp({
      pollRequest: false,
      queueItems: [makeBulkItem(correlationId, 'QUEUING_IN_PROGRESS', {validate: false})]
      // no stream seeded: reprocessing is not even possible, and it must not
      // be attempted in the first place
    });

    await mongoOperator.onEvent('state', 'ERROR');
    try {
      const queueItem = mongoOperator.items.get(correlationId);
      assert.equal(queueItem.state, 'ERROR');
      assert.deepStrictEqual(queueItem.stateLog, [{
        state: 'ERROR',
        errorMessage: {message: 'Worker restarted while the item was being queued/split; the item is left as stale and is not reprocessed.'},
        errorStatus: 500
      }]);
      // no reprocessing: nothing went to any queue and no records were read
      assert.deepStrictEqual(amqpOperator.state.sent, []);
      assert.deepStrictEqual(queueItem.recordResponses, []);
      assert.deepStrictEqual(queueItem.splitterReports, []);

      await drain();
    } finally {
      amqpOperator.stop();
      mongoOperator.stop();
    }
  });
});
