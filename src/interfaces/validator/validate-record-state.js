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

import deepEqual from 'deep-eql';
import {detailedDiff} from 'deep-object-diff';
import {Error as ValidationError} from '@natlibfi/melinda-commons';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {inspect} from 'util';
import HttpStatus from 'http-status';


// Checks that the modification history is identical
export function validateRecordState({incomingRecord, existingRecord, existingId, recordMetadata, validate}) {
  const logger = createLogger();

  if (validate === false) {
    logger.debug(`Skipping validateRecordState. Validate: ${validate}`);
    return 'skipped';
  }

  // get return empty array if there are no matching fields in the record
  const incomingModificationHistory = incomingRecord.get(/^CAT$/u).map(normalizeEmptySubfields);
  const existingModificationHistory = existingRecord.get(/^CAT$/u).map(normalizeEmptySubfields);

  // the next is not needed? this is not used with Merge-UI?
  // Merge makes uuid variables to all fields and this removes those
  //const incomingModificationHistoryNoUuids = incomingModificationHistory.map(field => ({tag: field.tag, ind1: field.ind1, ind2: field.ind2, subfields: field.subfields}));
  //const existingModificationHistoryNoUuids = existingModificationHistory.map(field => ({tag: field.tag, ind1: field.ind1, ind2: field.ind2, subfields: field.subfields}));

  logger.debug(`Incoming CATs (${incomingModificationHistory.length}), existing CATs (${existingModificationHistory.length})`);
  logger.silly(`Incoming CATs (${incomingModificationHistory.length}):\n${JSON.stringify(incomingModificationHistory)}`);
  logger.silly(`Existing CATs (${existingId}) (${existingModificationHistory.length}):\n${JSON.stringify(existingModificationHistory)}`);

  if (deepEqual(incomingModificationHistory, existingModificationHistory) === false) { // eslint-disable-line functional/no-conditional-statement
    logger.debug(`validateRecordState: failure`);
    logger.debug(`Differences in CATs: ${inspect(detailedDiff(incomingModificationHistory, existingModificationHistory), {colors: true, depth: 4})}`);
    throw new ValidationError(HttpStatus.CONFLICT, {message: `Modification history mismatch (CAT) with existing record ${existingId}`, recordMetadata, ids: [existingId]});
  }
  logger.debug(`validateRecordState: OK`);
  return true;

  function normalizeEmptySubfields(field) {
    return {
      ...field,
      subfields: field.subfields.map(normalizeEmptySubfield)
    };

    function normalizeEmptySubfield(subfield) {
      if (subfield.value && subfield.value !== undefined && subfield.value !== 'undefined') {
        //logger.silly('normal subfield');
        return subfield;
      }
      //logger.silly('normalized subfield');
      return {code: subfield.code, value: ''};
    }

  }

}
