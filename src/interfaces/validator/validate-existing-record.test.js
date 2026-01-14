import assert from 'node:assert';
import {describe} from 'node:test';
import createDebugLogger from 'debug';

import generateTests from '@natlibfi/fixugen';
import {READERS} from '@natlibfi/fixura';
import {MarcRecord} from '@natlibfi/marc-record';
import {validateExistingRecord} from './validate-existing-record.js';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:validate-existing-record:test');
const debugData = debug.extend('data');

describe('validateExistingRecord', () => {
  generateTests({
    path: [import.meta.dirname, '..', '..', '..', 'test-fixtures', 'validate-existing-record'],
    useMetadataFile: true,
    recurse: false,
    fixura: {
      reader: READERS.JSON
    },
    callback: ({getFixture, expectedToThrow, expectedStatus, expectedError, skipValidation}) => {

      const record = new MarcRecord(getFixture('record.json'), {subfieldValues: false});

      if (skipValidation) {
        debug(`Running validation with (3rd param) validate: false`);
        const result = validateExistingRecord(record, 'recordMetadata', false);
        debug(`Result: ${result}`);
        assert.equal(result, 'skipped');
        return;
      }

      debugData(`Expecting error: ${expectedToThrow}, ${expectedStatus}, ${expectedError}`);

      if (expectedToThrow) {
        try {
          validateExistingRecord(record, 'recordMetadata', true);
          throw new Error('Expected an error');
        } catch (err) {

          debug(`Got error: ${err.status}, ${err.payload}`);

          assert.equal(err instanceof Error, true);
          assert.equal(err.status, 404);
          assert.match(err.payload.message, new RegExp(expectedError, 'u'));
          return;
        }
      }

      try {
        validateExistingRecord(record);
        debug('Did not get an error.');
      } catch (err) {
        debugData(err);
        throw new Error('Did not expect an error');
      }
    }
  });
});
