
import createDebugLogger from 'debug';
import deepEqual from 'deep-eql';
import {detailedDiff} from 'deep-object-diff';
import httpStatus from 'http-status';
import {Error as ValidationError} from '@natlibfi/melinda-commons';
//import {createLogger} from '@natlibfi/melinda-backend-commons';
//import {inspect} from 'util';
import {toTwoDigits, normalizeEmptySubfields} from '../../utils.js';

// Checks that the modification history is identical
export function validateRecordState({incomingRecord, existingRecord, existingId, recordMetadata, validate, mergedIncomingRecord = true}) {
  //const logger = createLogger();
  const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:validate-record-state');
  const debugData = debug.extend('data');

  if (validate === false) {
    debug(`Skipping validateRecordState. Validate: ${validate}`);
    return 'skipped';
  }
  debug(`mergedIncomingRecord: ${mergedIncomingRecord}`);

  // MarcRecord.get returns empty array if there are no matching fields in the record
  // unique CATs, because in case of a merged incoming record merge uniques CATs in the incoming record, so that duplicate CATs in existing record cause unnecessary CONFLICTs
  debug(`----- Build ic`);
  const incomingModificationHistory = getModificationHistory({record: incomingRecord, needUnique: mergedIncomingRecord});
  debug(`----- Build db`);
  const existingModificationHistory = getModificationHistory({record: existingRecord, needUnique: mergedIncomingRecord});

  debug(`---- Comparing CATs`);
  debug(`Incoming CATs (${incomingModificationHistory.length}), existing CATs (${existingModificationHistory.length})`);
  debugData(`Incoming unique CATs (${incomingModificationHistory.length}): ${JSON.stringify(incomingModificationHistory)}`);
  debugData(`Existing unique CATs (${existingId}) (${existingModificationHistory.length}): ${JSON.stringify(existingModificationHistory)}`);

  if (deepEqual(incomingModificationHistory, existingModificationHistory) === false) {
    debug(`validateRecordState: failure`);
    debugData(`Differences in CATs: ${JSON.stringify(detailedDiff(incomingModificationHistory, existingModificationHistory), {colors: true, depth: 4})}`);
    debugData(`Incoming record: ${JSON.stringify(incomingRecord)}`);
    debugData(`Existing record: ${JSON.stringify(existingRecord)}`);
    throw new ValidationError(httpStatus.CONFLICT, {message: `Modification history mismatch (CAT) with existing record ${existingId}`, recordMetadata, ids: [existingId]});
  }
  debug(`validateRecordState: OK`);
  return true;

  function getModificationHistory({record, needUnique = true}) {
    debug(`needUnique: ${needUnique}`);
    return needUnique ? uniqueModificationHistory(record.get(/^CAT$/u).map(normalizeEmptySubfields)) : record.get(/^CAT$/u).map(normalizeEmptySubfields);
  }

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
    //debugData(`Removed: ${JSON.stringify(removed)}`);


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
        // throw CONFLICT only when (possibly) merging records
        throw new ValidationError(httpStatus.CONFLICT, {message: `Possible modification history mismatch (CAT) with existing record ${existingId}`, recordMetadata, ids: [existingId]});
      }
      debug(`There are non-unique CATs, but they are not current - using uniqued CATs`);
      return uniqueModificationHistoryStringArray.map(JSON.parse);
    }
    // We should never get here
    //return uniqueModificationHistory;
  }
}
