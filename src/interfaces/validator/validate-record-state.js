
import deepEqual from 'deep-eql';
import {detailedDiff} from 'deep-object-diff';
import {Error as ValidationError} from '@natlibfi/melinda-commons';
//import {createLogger} from '@natlibfi/melinda-backend-commons';
//import {inspect} from 'util';
import HttpStatus from 'http-status';
import createDebugLogger from 'debug';
import {toTwoDigits, normalizeEmptySubfields} from '../../utils';

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
  debug(`----- Build ic`);
  const incomingModificationHistory = uniqueModificationHistory(incomingRecord.get(/^CAT$/u).map(normalizeEmptySubfields));
  debug(`----- Build db`);
  const existingModificationHistory = uniqueModificationHistory(existingRecord.get(/^CAT$/u).map(normalizeEmptySubfields));

  debug(`---- Comparing CATs`);
  debug(`Incoming CATs (${incomingModificationHistory.length}), existing CATs (${existingModificationHistory.length})`);
  debugData(`Incoming unique CATs (${incomingModificationHistory.length}): ${JSON.stringify(incomingModificationHistory)}`);
  debugData(`Existing unique CATs (${existingId}) (${existingModificationHistory.length}): ${JSON.stringify(existingModificationHistory)}`);

  if (deepEqual(incomingModificationHistory, existingModificationHistory) === false) {
    debug(`validateRecordState: failure`);
    debugData(`Differences in CATs: ${JSON.stringify(detailedDiff(incomingModificationHistory, existingModificationHistory), {colors: true, depth: 4})}`);
    debugData(`Incoming record: ${JSON.stringify(incomingRecord)}`);
    debugData(`Existing record: ${JSON.stringify(existingRecord)}`);
    throw new ValidationError(HttpStatus.CONFLICT, {message: `Modification history mismatch (CAT) with existing record ${existingId}`, recordMetadata, ids: [existingId]});
  }
  debug(`validateRecordState: OK`);
  return true;

  // eslint-disable-next-line max-statements
  function uniqueModificationHistory(modificationHistory) {
    const modificationHistoryStringArray = modificationHistory.map(JSON.stringify);
    const uniqueModificationHistoryStringArray = [...new Set(modificationHistory.map(JSON.stringify))];

    if (modificationHistoryStringArray.length === uniqueModificationHistoryStringArray.length) {
      debug(`*** No duplicate CATs to remove ****`);
      return modificationHistory;
    }

    debugData(`All (${modificationHistoryStringArray.length}): ${modificationHistoryStringArray})}`);
    debugData(`Unique (${uniqueModificationHistoryStringArray.length}): ${uniqueModificationHistoryStringArray}`);

    // We're diffing uniqued CATs to non-uniqued CATS so removed CATs are labeled as 'added' by diff
    // We get the actual removed fields from diff by doing it this way
    const removed = detailedDiff(uniqueModificationHistoryStringArray, modificationHistoryStringArray).added;

    if (removed) {
      debug(`Uniquing CAT-fields removed duplicates (${Object.keys(removed).length}).`);
      const removedCats = Object.values(removed).map(JSON.parse);
      debugData(`Removed duplicate CATs: ${JSON.stringify(removedCats)}`);
      const removedTimeStamps = removedCats.map(({subfields}) => subfields.filter(subfield => ['c', 'h'].includes(subfield.code)).map(({value}) => value).join(''));
      debugData(`Removed timestamps: ${removedTimeStamps}`);

      const date = new Date(Date.now());
      // We the current timeStamp in the local timezone - this might cause problems some time?
      const currentTimeStamp = `${date.getFullYear()}${toTwoDigits(date.getMonth() + 1)}${toTwoDigits(date.getDate())}${toTwoDigits(date.getHours())}${toTwoDigits(date.getMinutes())}`;

      // We consider a CAT current, if it has timeStamp inside +- one minute of the current time
      const currentRemoved = removedTimeStamps.filter(timeStamp => Number(currentTimeStamp) - 1 < Number(timeStamp) && Number(timeStamp) < Number(currentTimeStamp) + 1);

      // throw CONFLICT for current duplicate CATs, because we cannot know whether there would have been the same duplicate CAT in the incoming merged record or if the existing record was updated again
      if (currentRemoved.length > 0) {
        debug(`There are non-unique CATs that are current (${currentRemoved.length}) - cannot unique CATs`);
        debugData(`Current CATs that would have been removed: ${JSON.stringify(currentRemoved)}`);
        throw new ValidationError(HttpStatus.CONFLICT, {message: `Possible modification history mismatch (CAT) with existing record ${existingId}`, recordMetadata, ids: [existingId]});
      }
      debug(`There are non-unique CATs, but they are not current - using uniqued CATs`);
      return uniqueModificationHistoryStringArray.map(JSON.parse);
    }
    // We should never get here
    //return uniqueModificationHistory;
  }
}
