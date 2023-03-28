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
import {validateChanges} from './validate-changes';
import createDebugLogger from 'debug';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:validate-changes:test');
const debugData = debug.extend('data');


describe('validateChanges', () => {
  generateTests({
    path: [__dirname, '..', '..', '..', 'test-fixtures', 'validate-changes'],
    useMetadataFile: true,
    recurse: false,
    fixura: {
      reader: READERS.JSON
    },
    // eslint-disable-next-line max-statements
    callback: ({getFixture, expectedResult, skipValidation}) => {

      const record1 = new MarcRecord(getFixture('record1.json'));
      const record2 = new MarcRecord(getFixture('record2.json'));
      debugData(`Record1:\n${record1}`);
      debugData(`Record2:\n${record2}`);

      if (skipValidation) {
        debug(`Running validation with (4th param) validate: false`);
        const result = validateChanges({incomingRecord: record1, existingRecord: record2, existingId: '000123456', recordMetadata: 'recordMetadata', validate: false});
        debug(`Result: ${result}`);
        expect(result.changeValidationResult).to.equal('skipped');
        return;
      }

      /*
      if (expectedToThrow) { // eslint-disable-line functional/no-conditional-statement
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
        expect(result.changeValidationResult).to.equal(expectedResult);
      } catch (err) {
        debugData(err);
        throw new Error('Did not expect an error');
      }
    }

  });
});

