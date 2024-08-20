
import generateTests from '@natlibfi/fixugen';
import {READERS} from '@natlibfi/fixura';
import {expect} from 'chai';
import {MarcRecord} from '@natlibfi/marc-record';
import {validateExistingRecord} from './validate-existing-record';
import createDebugLogger from 'debug';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:validate-existing-record:test');
const debugData = debug.extend('data');

describe('validateExistingRecord', () => {
  generateTests({
    path: [__dirname, '..', '..', '..', 'test-fixtures', 'validate-existing-record'],
    useMetadataFile: true,
    recurse: false,
    fixura: {
      reader: READERS.JSON
    },
    // eslint-disable-next-line max-statements
    callback: ({getFixture, expectedToThrow, expectedStatus, expectedError, skipValidation}) => {

      const record = new MarcRecord(getFixture('record.json'), {subfieldValues: false});

      if (skipValidation) {
        debug(`Running validation with (3rd param) validate: false`);
        const result = validateExistingRecord(record, 'recordMetadata', false);
        debug(`Result: ${result}`);
        expect(result).to.equal('skipped');
        return;
      }

      debugData(`Expecting error: ${expectedToThrow}, ${expectedStatus}, ${expectedError}`);

      // eslint-disable-next-line functional/no-conditional-statements
      if (expectedToThrow) {
        try {
          validateExistingRecord(record, 'recordMetadata', true);
          throw new Error('Expected an error');
        } catch (err) {

          debug(`Got error: ${err.status}, ${err.payload}`);

          expect(err).to.be.an('error');
          expect(err.status).to.equal(404);
          expect(err.payload.message).to.match(new RegExp(expectedError, 'u'));
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
