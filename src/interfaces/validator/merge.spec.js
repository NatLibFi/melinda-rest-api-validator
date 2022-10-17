/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* RESTful API for Melinda - record validation services
*
* Copyright (C) 2018-2022 University Of Helsinki (The National Library Of Finland)
*
* This file is part of melinda-rest-api-validator
*
* melinda-rest-api-validator program is free software: you can redistribute it and/or modify
* it under the terms of the GNU Affero General Public License as
* published by the Free Software Foundation, either version 3 of the
* License, or (at your option) any later version.
*
* melinda-rest-api-validator is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU Affero General Public License for more details.
*
* You should have received a copy of the GNU Affero General Public License
* along with this program.  If not, see <http://www.gnu.org/licenses/>.
*
* @licend  The above is the entire license notice
* for the JavaScript code in this file.
*
*/

import generateTests from '@natlibfi/fixugen';
import {READERS} from '@natlibfi/fixura';
import {expect} from 'chai';
import {MarcRecord} from '@natlibfi/marc-record';
import merger from './merge';
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
    callback: ({getFixture, expectedResultStatus, expectedToThrow, expectedStatus, expectedError, recordType = 'bib', enabled = true}) => {

      debug(`Running test`);

      if (!enabled) {
        debug(`This test is disabled in metadata.json`);
        return;
      }

      const record1 = new MarcRecord(getFixture('record1.json'));
      const record2 = new MarcRecord(getFixture('record2.json'));

      debug(`We have records`);

      if (expectedToThrow) { // eslint-disable-line functional/no-conditional-statement
        debugData(`Expecting error: ${expectedToThrow}, ${expectedStatus}, ${expectedError}`);
        try {
          debug(`Trying to run merge`);
          const result = merger({base: record1, source: record2, recordType});
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
      const result = merger({base: record1, source: record2, recordType});
      //debugData(result.status);
      //debug('Did not get an error.');
      expect(result.status).to.equal(expectedResultStatus);
      //debugData(result.record);
      //debugData(expectedMergedRecord);
      expect(result.record.toString()).to.equal(expectedMergedRecord.toString());
    }

  });
});

