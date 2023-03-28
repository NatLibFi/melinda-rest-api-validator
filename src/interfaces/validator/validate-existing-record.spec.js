/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* Melinda record matching modules for Javascript
*
* Copyright (C) 2020 University Of Helsinki (The National Library Of Finland)
*
* This file is part of melinda-record-matching-js
*
* melinda-record-matching-js program is free software: you can redistribute it and/or modify
* it under the terms of the GNU Lesser General Public License as
* published by the Free Software Foundation, either version 3 of the
* License, or (at your option) any later version.
*
* melinda-record-matching-js is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU Lesser General Public License for more details.
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

      const record = new MarcRecord(getFixture('record.json'));

      if (skipValidation) {
        debug(`Running validation with (3rd param) validate: false`);
        const result = validateExistingRecord(record, 'recordMetadata', false);
        debug(`Result: ${result}`);
        expect(result).to.equal('skipped');
        return;
      }

      debugData(`Expecting error: ${expectedToThrow}, ${expectedStatus}, ${expectedError}`);

      if (expectedToThrow) { // eslint-disable-line functional/no-conditional-statement
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
