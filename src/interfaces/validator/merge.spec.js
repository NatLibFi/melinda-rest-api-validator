
import generateTests from '@natlibfi/fixugen';
import {READERS} from '@natlibfi/fixura';
import {expect} from 'chai';
import {MarcRecord} from '@natlibfi/marc-record';
import mergeFromValidator from './merge';
import createDebugLogger from 'debug';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:merge:test');
const debugData = debug.extend('data');

describe('merge', () => {
  generateTests({
    path: [__dirname, '..', '..', '..', 'test-fixtures', 'merge'],
    useMetadataFile: true,
    recurse: false,
    fixura: {
      reader: READERS.JSON
    },
    // eslint-disable-next-line max-statements
    callback: ({getFixture, expectedResultStatus, expectedToThrow, expectedStatus, expectedError, recordType = 'bib'}) => {

      debug(`Running test`);

      const record1 = new MarcRecord(getFixture('record1.json'), {subfieldValues: false});
      const record2 = new MarcRecord(getFixture('record2.json'), {subfieldValues: false});
      //const record1 = getFixture('record1.json');
      //const record2 = getFixture('record2.json');


      debug(`We have records`);

      // eslint-disable-next-line functional/no-conditional-statements
      if (expectedToThrow) {
        debugData(`Expecting error: ${expectedToThrow}, ${expectedStatus}, ${expectedError}`);
        try {
          debug(`Trying to run merge`);
          const result = mergeFromValidator({base: record1, source: record2, recordType});
          debugData(result);
          throw new Error('Expected an error');
        } catch (err) {

          debug(`Got error: ${err.status}, ${JSON.stringify(err.payload)}`);
          //debugData(err);

          expect(err).to.be.an('error');
          expect(err.status).to.equal(expectedStatus);
          expect(err.payload).to.match(new RegExp(expectedError, 'u'));
          return;
        }
      }

      const expectedMergedRecord = new MarcRecord(getFixture('mergedRecord.json'), {subfieldValues: false});
      const result = mergeFromValidator({base: record1, source: record2, recordType});
      //debugData(result.status);
      //debug('Did not get an error.');
      expect(result.status).to.equal(expectedResultStatus);
      //debugData(result.record);
      //debugData(expectedMergedRecord);
      expect(result.record.toString()).to.equal(expectedMergedRecord.toString());
    }

  });
});

