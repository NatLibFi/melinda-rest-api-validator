
import assert from 'node:assert';
import {describe} from 'node:test';
import createDebugLogger from 'debug';
import generateTests from '@natlibfi/fixugen';
import {READERS} from '@natlibfi/fixura';
import {MarcRecord} from '@natlibfi/marc-record';
import {validateRecordState} from './validate-record-state.js';
import {toTwoDigits} from '../../utils.js';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:validate-record-state:test');
const debugData = debug.extend('data');

function updateCatsInRecord(record, updateCats) {

  if (!updateCats) {
    return record;
  }

  const date = new Date(Date.now());
  // We seem to get the current timeStamp in the local timezone - this might cause problems some time?
  const currentTimeStampForC = `${date.getFullYear()}${toTwoDigits(date.getMonth() + 1)}${toTwoDigits(date.getDate())}`;
  const currentTimeStampForH = `${toTwoDigits(date.getHours())}${toTwoDigits(date.getMinutes())}`;
  debug(`Created current timestamp ${currentTimeStampForC}, ${currentTimeStampForH}`);

  /*
  const {leader} = record;
  debugData(leader);
  const fields = updateCatFields(record.fields, currentTimeStampForC, currentTimeStampForH);
  debugData(fields);
*/

  return new MarcRecord({
    leader: record.leader,
    fields: updateCatFields(record.fields, currentTimeStampForC, currentTimeStampForH)
  }, {subfieldValues: false});

  function updateCatFields(fields, timeC, timeH) {
    return fields.map(updateCat);

    function updateCat(field) {
      if (field.tag !== 'CAT') {
        return field;
      }

      return {
        tag: field.tag,
        ind1: field.ind1,
        ind2: field.ind2,
        subfields: field.subfields.map(updateSubfield)
      };
    }

    function updateSubfield(subfield) {
      if (subfield.code === 'c') {
        return {code: subfield.code, value: subfield.value.replace(/\[replaceBy:currentDateYYYYMMDD\]/u, timeC)};
      }

      if (subfield.code === 'h') {
        return {code: subfield.code, value: subfield.value.replace(/\[replaceBy:currentDateHHMM\]/u, timeH)};
      }
      return subfield;

    }
  }
}

describe('validateRecordState', () => {
  generateTests({
    path: [import.meta.dirname, '..', '..', '..', 'test-fixtures', 'validate-record-state'],
    useMetadataFile: true,
    recurse: false,
    fixura: {
      reader: READERS.JSON
    },
    callback: ({getFixture, expectedToThrow, expectedStatus, expectedError, skipValidation, updateCats, mergedIncomingRecord = true}) => {

      const record1 = updateCatsInRecord(new MarcRecord(getFixture('record1.json'), {subfieldValues: false}), updateCats);
      const record2 = updateCatsInRecord(new MarcRecord(getFixture('record2.json'), {subfieldValues: false}), updateCats);

      if (skipValidation) {
        debug(`Running validation with (4th param) validate: false`);
        const result = validateRecordState({incomingRecord: record1, existingRecord: record2, existingId: '000123456', recordMetadata: 'recordMetadata', validate: false, mergedIncomingRecord});
        debug(`Result: ${result}`);
        assert.equal(result, 'skipped');
        return;
      }

      if (expectedToThrow) {
        debugData(`Expecting error: ${expectedToThrow}, ${expectedStatus}, ${expectedError}`);
        try {
          validateRecordState({incomingRecord: record1, existingRecord: record2, existingId: '000123456', recordMetadata: 'recordMetadata', validate: true, mergedIncomingRecord});
          throw new Error('Expected an error');
        } catch (err) {

          debug(`Got error: ${err.status}, ${JSON.stringify(err.payload)}`);

          assert.equal(err instanceof Error, true);
          assert.equal(err.status, expectedStatus);
          assert.match(err.payload.message, new RegExp(expectedError, 'u'));
          return;
        }
      }

      try {
        validateRecordState({incomingRecord: record1, existingRecord: record2, existingId: '000123456', recordMetadata: 'recordMetadata', validate: true, mergedIncomingRecord});
        debug('Did not get an error.');
      } catch (err) {
        debugData(err);
        throw new Error('Did not expect an error');
      }
    }

  });
});

