import assert from 'node:assert';
import {describe} from 'node:test';
import createDebugLogger from 'debug';

import generateTests from '@natlibfi/fixugen';
import {READERS} from '@natlibfi/fixura';
import {MarcRecord} from '@natlibfi/marc-record';
import {validateUpdate} from './validate-update.js';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:validate-update:test');
const debugData = debug.extend('data');


describe('validateUpdate', () => {
  generateTests({
    path: [import.meta.dirname, '..', '..', '..', 'test-fixtures', 'validate-update'],
    useMetadataFile: true,
    recurse: false,
    fixura: {
      reader: READERS.JSON
    },
    // eslint-disable-next-line max-statements
    callback: ({getFixture, expectedResult, cataloger, skipValidation = false}) => {

      const record1 = new MarcRecord(getFixture('record1.json'), {subfieldValues: false});
      const record2 = new MarcRecord(getFixture('record2.json'), {subfieldValues: false});
      debugData(`Record1:\n${record1}`);
      debugData(`Record2:\n${record2}`);

      if (skipValidation) {
        debug(`Running validation with validate: false`);
        const result = validateUpdate({incomingRecord: record1, existingRecord: record2, cataloger, validate: false});
        debug(`Result: ${JSON.stringify(result)}`);
        assert.equal(result.updateValidationResult, 'skipped');
        return;
      }

      try {
        const result = validateUpdate({incomingRecord: record1, existingRecord: record2, cataloger, validate: true});
        debug('Did not get an error.');
        assert.deepStrictEqual(result.updateValidationResult, expectedResult);
      } catch (err) {
        debugData(err);
        throw new Error('Did not expect an error');
      }
    }

  });
});

