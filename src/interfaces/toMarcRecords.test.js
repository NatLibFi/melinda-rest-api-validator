import assert from 'node:assert';
import {Readable} from 'node:stream';
import {describe, it} from 'node:test';
import {AlephSequential, ISO2709, MARCXML} from '@natlibfi/marc-record-serializers';
import {MarcRecord} from '@natlibfi/marc-record';
import generateTests from '@natlibfi/fixugen';
import {READERS} from '@natlibfi/fixura';
import streamToRecordsFactory from './toMarcRecords.js';

MarcRecord.setValidationOptions({subfieldValues: false});

const LEADER = '00000nam a2200000 a 4500';

// streamToRecords takes the stream + operators as params, so no DI seam is
// needed; the fakes capture the outcomes (checked/queued/removed queues,
// response items, splitter reports, log items) instead of counting calls.
const createFakeAmqpOperator = () => {
  const state = {checked: [], sent: [], removed: []};
  return {
    state,
    checkQueue: async (args) => {
      state.checked.push(args);
      return [];
    },
    sendToQueue: async (args) => state.sent.push(args),
    removeQueue: (queue) => state.removed.push(queue)
  };
};

const createFakeMongoOperator = () => {
  const state = {recordItems: [], splitterReports: [], blobSizes: []};
  return {
    state,
    pushMessages: async ({messages, messageField}) => {
      if (messageField === 'records') {
        state.recordItems.push(...messages);
        return;
      }
      state.splitterReports.push(...messages);
    },
    setBlobSize: (args) => state.blobSizes.push(args)
  };
};

const createFakeMongoLogOperator = () => {
  const state = {logItems: []};
  return {state, addLogItem: (logItem) => state.logItems.push(logItem)};
};

const makeRecord = (fields) => new MarcRecord({leader: LEADER, fields}, {subfieldValues: false});

// Fixture payloads are record objects (fields) or raw strings: the readers
// need ALEPHSEQ/JSON/MARCXML/ISO2709 encodings, so the payload is serialized
// here per contentType.
const buildStream = async ({contentType, records = [], rawPayload, streamError}) => {
  if (streamError) {
    const xml = MARCXML.to(makeRecord(records[0].fields), {subfieldValues: false});
    return new Readable({
      read() {
        // A partial record followed by a stream error
        this.push(Buffer.from(String(xml).slice(0, 20)));
        this.push(null);
        this.emit('error', new Error(streamError));
      }
    });
  }
  if (rawPayload !== undefined) {
    return Readable.from([rawPayload]);
  }
  if (contentType === 'application/json') {
    return Readable.from([JSON.stringify(records)]);
  }
  const record = makeRecord(records[0].fields);
  if (contentType === 'application/xml') {
    return Readable.from([MARCXML.to(record, {subfieldValues: false})]);
  }
  if (contentType === 'application/marc') {
    return Readable.from([ISO2709.to(record, {subfieldValues: false})]);
  }
  return Readable.from([AlephSequential.to(record, {subfieldValues: false})]);
};

// The reader 'end' handler waits 500 ms before it finishes, so a rejected
// promise can settle while that handler is still running; let it land before
// asserting the final fake state.
const settle = () => new Promise((resolve) => {setTimeout(resolve, 900);});

// recordMetadata can hold explicit undefined properties (sourceIds, title,
// standardIdentifiers) which JSON fixtures cannot express; compare both
// sides after a JSON round-trip.
const jsonSafe = (value) => JSON.parse(JSON.stringify(value));

describe('toMarcRecords (stream splitting)', () => {
  generateTests({
    path: [import.meta.dirname, '..', '..', 'test-fixtures', 'toMarcRecords'],
    useMetadataFile: true,
    recurse: false,
    fixura: {reader: READERS.JSON},
    callback: async (fixture) => {
      const {
        contentType,
        operation,
        failOnError,
        useDefaultFailOnError = false,
        failBulkOnError = false,
        keepSplitterReport = 'NONE',
        validateRecords = false,
        noop = false,
        expected
      } = fixture;
      const amqpOperator = createFakeAmqpOperator();
      const mongoOperator = createFakeMongoOperator();
      const mongoLogOperator = createFakeMongoLogOperator();
      const {streamToRecords} = streamToRecordsFactory({
        amqpOperator,
        mongoOperator,
        mongoLogOperator,
        splitterOptions: {failBulkOnError, keepSplitterReport}
      });

      const stream = await buildStream(fixture);
      const headers = {operation, correlationId: 'corr-1', cataloger: {id: 'user1'}};
      const args = {correlationId: 'corr-1', headers, contentType, stream, validateRecords, noop};
      // failOnError omitted on purpose in some cases: it must fall back to
      // splitterOptions.failBulkOnError
      if (!useDefaultFailOnError) {
        args.failOnError = failOnError;
      }

      if (expected.result === 'resolved') {
        await streamToRecords(args);
      } else {
        await assert.rejects(streamToRecords(args), (err) => {
          assert.strictEqual(err.status, expected.rejectStatus);
          assert.deepStrictEqual(err.payload, expected.rejectPayload);
          return true;
        });
        await settle();
      }

      const assertState = (actual, expectation) =>
        assert.deepStrictEqual(jsonSafe(actual), jsonSafe(expectation ?? []));
      assertState(amqpOperator.state.checked, expected.checked);
      assertState(amqpOperator.state.sent, expected.sent);
      assertState(amqpOperator.state.removed, expected.removed);
      assertState(mongoOperator.state.recordItems, expected.recordItems);
      assertState(mongoOperator.state.splitterReports, expected.splitterReports);
      assertState(mongoOperator.state.blobSizes, expected.blobSizes);
      assertState(mongoLogOperator.state.logItems, expected.logItems);
    }
  });

  describe('toMarcRecords (100th record logging)', () => {
    it('Should log the 100th record at debug level and queue all records', async () => {
      // 100 programmatically generated records: the 100th triggers the
      // log100thQueue debug branch (record % 100 === 0)
      const records = Array.from({length: 100}, (_, i) => makeRecord([
        {tag: '245', ind1: '1', ind2: ' ', subfields: [{code: 'a', value: `title ${i + 1}.`}]}
      ]));
      const amqpOperator = createFakeAmqpOperator();
      const mongoOperator = createFakeMongoOperator();
      const mongoLogOperator = createFakeMongoLogOperator();
      // LOG_LEVEL is read by createLogger() when the factory runs, so it must
      // be set before. Capture stdout while forwarding every chunk to the
      // original write: the test runner itself speaks a protocol on stdout,
      // so swallowing writes would corrupt the test results.
      const previousLogLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = 'debug';
      const {streamToRecords} = streamToRecordsFactory({
        amqpOperator, mongoOperator, mongoLogOperator,
        splitterOptions: {failBulkOnError: false, keepSplitterReport: 'NONE'}
      });
      const captured = [];
      const stdoutStream = process.stdout;
      const originalWrite = stdoutStream.write.bind(stdoutStream);
      process.stdout.write = (chunk, ...args) => {captured.push(String(chunk)); return originalWrite(chunk, ...args);};
      try {
        const stream = Readable.from([JSON.stringify(records)]);
        const headers = {operation: 'CREATE', correlationId: 'corr-100', cataloger: {id: 'user1'}};
        await streamToRecords({correlationId: 'corr-100', headers, contentType: 'application/json', stream, validateRecords: false, noop: false});
      } finally {
        process.stdout.write = originalWrite;
        if (previousLogLevel === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = previousLogLevel;
      }
      const output = captured.join('');
      assert.ok(output.includes('Record 100 has been read'), 'output did not contain the 100th record debug line');
      assert.equal(amqpOperator.state.sent.length, 100);
    });
  });
});
