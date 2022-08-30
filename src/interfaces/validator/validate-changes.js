/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* RESTful API for Melinda - record validation services
*
* Copyright (C) 2022 University Of Helsinki (The National Library Of Finland)
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

import deepEqual from 'deep-eql';
import {detailedDiff} from 'deep-object-diff';
import createDebugLogger from 'debug';
import {normalizeEmptySubfieldsRecord} from '../../utils';

// Checks that the incomingRecord and existingRecord are not identical
export function validateChanges({incomingRecord, existingRecord, validate = true}) {
  const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:validate-changes');
  const debugData = debug.extend('data');

  if (validate === false) {
    debug(`Skipping validateChanges. Validate: ${validate}`);
    return {changeValidationResult: 'skipped'};
  }

  // normalizeEmptySubfieldsRecord is an utility function which normalizes all all cases of empty subfield value {code: x, value: ""}, {code: x}, {code: x, value: undefined}  to {value: ""}
  // this is needed, because there are CAT-fields that have empty value in subfield $b
  // we could optimize this step out, if we could be sure that empty subfield values are normalized somewhere else

  const normIncomingRecord = normalizeEmptySubfieldsRecord(incomingRecord);
  const normExistingRecord = normalizeEmptySubfieldsRecord(existingRecord);

  if (deepEqual(normIncomingRecord, normExistingRecord) === true) { // eslint-disable-line functional/no-conditional-statement

    debug(`validateChanges: failure - there are no changes between incomingRecord and existingRecord`);
    debugData(`Differences in records: ${JSON.stringify(detailedDiff(normExistingRecord, normIncomingRecord), {colors: true, depth: 4})}`);
    debugData(`Incoming record: ${JSON.stringify(incomingRecord)}`);
    debugData(`Existing record: ${JSON.stringify(existingRecord)}`);
    // should we error here or return a result?
    return {changeValidationResult: false};
  }
  debug(`validateChanges: OK - there are changes between incomingRecord and existingRecord`);
  debugData(`Differences in records: ${JSON.stringify(detailedDiff(normExistingRecord, normIncomingRecord), {colors: true, depth: 4})}`);
  debugData(`Incoming record: ${JSON.stringify(incomingRecord)}`);
  debugData(`Existing record: ${JSON.stringify(existingRecord)}`);

  return {changeValidationResult: true};
}
