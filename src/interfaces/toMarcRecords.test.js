import assert from 'node:assert';
import {Readable} from 'node:stream';
import {describe} from 'node:test';
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
});
