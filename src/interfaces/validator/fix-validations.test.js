import assert from 'node:assert';
import {EventEmitter} from 'node:events';
import {describe} from 'node:test';
import {MarcRecord} from '@natlibfi/marc-record';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import generateTests from '@natlibfi/fixugen';
import {READERS} from '@natlibfi/fixura';
import {fixValidationsFactory} from './fix-validations.js';

MarcRecord.setValidationOptions({subfieldValues: false});

const LEADER = '00000nam a2200000 a 4500';

// The approved DI seam (optional sruClient in the options arg) lets us pass
// a fake SRU client in the established utils.test.js pattern:
// searchRetrieve(query) -> EventEmitter emitting record/end/error.
const createFakeSruClient = (marcXml, error) => {
  const queries = [];
  return {
    queries,
    searchRetrieve(query) {
      queries.push(query);
      const emitter = new EventEmitter();
      setImmediate(() => {
        if (error) {
          emitter.emit('error', error);
          return;
        }
        if (marcXml) {
          emitter.emit('record', marcXml);
        }
        emitter.emit('end');
      });
      return emitter;
    }
  };
};

const createFakeMongoLogOperator = () => {
  const state = {logItems: []};
  return {state, addLogItem: (logItem) => state.logItems.push(logItem)};
};

describe('fix-validations', () => {
  generateTests({
    path: [import.meta.dirname, '..', '..', '..', 'test-fixtures', 'fix-validations'],
    useMetadataFile: true,
    recurse: false,
    fixura: {reader: READERS.JSON},
    callback: async ({
      fixType,
      validate = true,
      sruScenario,
      useRealSruClient = false,
      sruUrl = 'http://sru.test/unused',
      leader = LEADER,
      recordFields = [],
      expected,
      expectedError
    }) => {
      const headers = {
        operationSettings: {fixType, validate},
        id: '000019640',
        correlationId: 'corr-1'
      };
      const recordXml = ['found', 'error'].includes(sruScenario)
        ? MARCXML.to(new MarcRecord({leader, fields: recordFields}, {subfieldValues: false}),
          {subfieldValues: false})
        : null;
      const sruClient = useRealSruClient
        ? undefined
        : createFakeSruClient(
          recordXml,
          sruScenario === 'error' ? new Error('sru down') : null
        );

      const {fixValidations} = fixValidationsFactory(createFakeMongoLogOperator(), {
        sruUrl,
        sruClient
      });

      if (expectedError) {
        await assert.rejects(fixValidations({headers}), (err) => {
          if (expectedError.status) {
            assert.strictEqual(err.status, expectedError.status);
            assert.deepStrictEqual(err.payload, expectedError.payload);
          }
          if (expectedError.message) {
            assert.strictEqual(err.message, expectedError.message);
          }
          return true;
        });
      } else {
        const result = await fixValidations({headers});
        assert.deepStrictEqual(result, expected);
      }

      if (!useRealSruClient) {
        assert.deepStrictEqual(sruClient.queries, ['rec.id=000019640']);
      }
    }
  });
});
