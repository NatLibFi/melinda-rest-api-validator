import assert from 'node:assert';
import {describe} from 'node:test';
import createDebugLogger from 'debug';

import generateTests from '@natlibfi/fixugen';
import {READERS} from '@natlibfi/fixura';
import {MarcRecord} from '@natlibfi/marc-record';
import {validateChanges} from './validate-changes.js';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:validate-changes:test');
const debugData = debug.extend('data');


describe('validateChanges', () => {
  generateTests({
    path: [import.meta.dirname, '..', '..', '..', 'test-fixtures', 'validate-changes'],
    useMetadataFile: true,
    recurse: false,
    fixura: {
      reader: READERS.JSON
    },
    // eslint-disable-next-line max-statements
    callback: ({getFixture, expectedResult, skipValidation}) => {

      const record1 = new MarcRecord(getFixture('record1.json'), {subfieldValues: false});
      const record2 = new MarcRecord(getFixture('record2.json'), {subfieldValues: false});
      debugData(`Record1:\n${record1}`);
      debugData(`Record2:\n${record2}`);

      if (skipValidation) {
        debug(`Running validation with (4th param) validate: false`);
        const result = validateChanges({incomingRecord: record1, existingRecord: record2, existingId: '000123456', recordMetadata: 'recordMetadata', validate: false});
        debug(`Result: ${result}`);
        assert.equal(result.changeValidationResult, 'skipped');
        return;
      }

      /*
      if (expectedToThrow) {
        debugData(`Expecting error: ${expectedToThrow}, ${expectedStatus}, ${expectedError}`);
        try {
          validateChanges({incomingRecord: record1, existingRecord: record2, validate: true});
          throw new Error('Expected an error');
        } catch (err) {

          debug(`Got error: ${err.status}, ${JSON.stringify(err.payload)}`);

          expect(err).to.be.an('error');
          expect(err.status).to.equal(expectedStatus);
          expect(err.payload.message).to.match(new RegExp(expectedError, 'u'));
          return;
        }
      }
      */

      try {
        const result = validateChanges({incomingRecord: record1, existingRecord: record2, validate: true});
        debug('Did not get an error.');
        assert.deepStrictEqual(result.changeValidationResult, expectedResult);
      } catch (err) {
        debugData(err);
        throw new Error('Did not expect an error');
      }
    }

  });
});

