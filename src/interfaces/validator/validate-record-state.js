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
//import {createLogger} from '@natlibfi/melinda-backend-commons';
//import {inspect} from 'util';
import HttpStatus from 'http-status';
import createDebugLogger from 'debug';
import {toTwoDigits} from '../../utils';

// Checks that the modification history is identical
export function validateRecordState({incomingRecord, existingRecord, existingId, recordMetadata, validate}) {
  //const logger = createLogger();
  const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:validate-record-state');
  const debugData = debug.extend('data');

  if (validate === false) {
    debug(`Skipping validateRecordState. Validate: ${validate}`);
    return 'skipped';
  }

  // MarcRecord.get returns empty array if there are no matching fields in the record
  // unique CATs, because in case of a merged incoming record merge uniques CATs in the incoming record, so that duplicate CATs in existing record cause unnecessary CONFLICTs
  const incomingModificationHistory = uniqueModificationHistory(incomingRecord.get(/^CAT$/u).map(normalizeEmptySubfields));
  const existingModificationHistory = uniqueModificationHistory(existingRecord.get(/^CAT$/u).map(normalizeEmptySubfields));

  debug(`Incoming CATs (${incomingModificationHistory.length}), existing CATs (${existingModificationHistory.length})`);
  debugData(`Incoming unique CATs (${incomingModificationHistory.length}): ${JSON.stringify(incomingModificationHistory)}`);
  debugData(`Existing unique CATs (${existingId}) (${existingModificationHistory.length}): ${JSON.stringify(existingModificationHistory)}`);

  if (deepEqual(incomingModificationHistory, existingModificationHistory) === false) { // eslint-disable-line functional/no-conditional-statement
    debug(`validateRecordState: failure`);
    debugData(`Differences in CATs: ${JSON.stringify(detailedDiff(incomingModificationHistory, existingModificationHistory), {colors: true, depth: 4})}`);
    debugData(`Incoming record: ${JSON.stringify(incomingRecord)}`);
    debugData(`Existing record: ${JSON.stringify(existingRecord)}`);
    throw new ValidationError(HttpStatus.CONFLICT, {message: `Modification history mismatch (CAT) with existing record ${existingId}`, recordMetadata, ids: [existingId]});
  }
  debug(`validateRecordState: OK`);
  return true;

  function uniqueModificationHistory(modificationHistory) {
    const uniqueModificationHistory = [...new Set(modificationHistory.map(JSON.stringify))].map(JSON.parse);

    if (modificationHistory.length === uniqueModificationHistory.length) {
      debug(`*** No duplicate CATs to remove ****`);
      return modificationHistory;
    }
    debug(`***********`);

    //debugData(`All (${modificationHistory.length}): ${inspect(modificationHistory, {depth: 5})}`);
    //debugData(`Unique (${uniqueModificationHistory.length}): ${inspect(uniqueModificationHistory, {depth: 5})}`);

    // We're diffing uniqued CATs to non-uniqued CATS so removed CATs are labeled as 'added' by diff
    // We get the actual removed fields from diff by doing it this way
    const removed = detailedDiff(uniqueModificationHistory, modificationHistory).added;
    debugData(`Removed CATS: ${JSON.stringify(removed)}`);
    //debugData(inspect(removed, {depth: 6}));

    if (removed) {
      debug(`Uniquing CAT-fields removed duplicates (${Object.keys(removed).length}).`);
      const removedTimeStamps = Object.values(removed).map(({subfields}) => subfields.filter(subfield => ['c', 'h'].includes(subfield.code)).map(({value}) => value).join(''));
      debugData(removedTimeStamps);

      const date = new Date(Date.now());
      // We the current timeStamp in the local timezone - this might cause problems some time?
      const currentTimeStamp = `${date.getFullYear()}${toTwoDigits(date.getMonth() + 1)}${toTwoDigits(date.getDate())}${toTwoDigits(date.getHours())}${toTwoDigits(date.getMinutes())}`;

      // We consider a CAT current, if it has timeStamp inside +- one minute of the current time
      const currentRemoved = removedTimeStamps.filter(timeStamp => Number(currentTimeStamp) - 1 < Number(timeStamp) && Number(timeStamp) < Number(currentTimeStamp) + 1);

      // throw CONFLICT for current duplicate CATs, because we cannot know whether there would have been the same duplicate CAT in the incoming merged record or if the existing record was updated again
      if (currentRemoved.length > 0) {
        debug(`There are non-unique CATs that are current - cannot unique CATs`);
        debugData(`Current CATs that would have been removed: ${JSON.stringify(currentRemoved)}`);
        throw new ValidationError(HttpStatus.CONFLICT, {message: `Possible modification history mismatch (CAT) with existing record ${existingId}`, recordMetadata, ids: [existingId]});
      }
      debug(`There are non-unique CATs, but they are not current - using uniqued CATs`);
      return uniqueModificationHistory;
    }
    // We should never get here
    //return uniqueModificationHistory;
  }

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
