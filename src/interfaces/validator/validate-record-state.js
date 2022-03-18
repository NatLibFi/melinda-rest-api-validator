import deepEqual from 'deep-eql';
import {detailedDiff} from 'deep-object-diff';
import {Error as ValidationError} from '@natlibfi/melinda-commons';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {inspect} from 'util';
import HttpStatus from 'http-status';


// Checks that the modification history is identical
export function validateRecordState(incomingRecord, existingRecord) {
  const logger = createLogger();

  const incomingModificationHistory = incomingRecord.get(/^CAT$/u) || [];
  const existingModificationHistory = existingRecord.get(/^CAT$/u) || [];

  // the next is not needed? this is not used with Merge-UI?
  // Merge makes uuid variables to all fields and this removes those
  //const incomingModificationHistoryNoUuids = incomingModificationHistory.map(field => ({tag: field.tag, ind1: field.ind1, ind2: field.ind2, subfields: field.subfields}));
  //const existingModificationHistoryNoUuids = existingModificationHistory.map(field => ({tag: field.tag, ind1: field.ind1, ind2: field.ind2, subfields: field.subfields}));

  logger.debug(`Incoming CATs (${incomingModificationHistory.length}), existing CATs (${existingModificationHistory.length})`);
  logger.silly(`Incoming CATs (${incomingModificationHistory.length}):\n${JSON.stringify(incomingModificationHistory)}`);
  logger.silly(`Existing CATs (${existingModificationHistory.length}):\n${JSON.stringify(existingModificationHistory)}`);

  if (deepEqual(incomingModificationHistory, existingModificationHistory) === false) { // eslint-disable-line functional/no-conditional-statement
    logger.debug(`validateRecordState: failure`);
    logger.debug(`Differences in CATs: ${inspect(detailedDiff(incomingModificationHistory, existingModificationHistory), {colors: true, depth: 4})}`);
    throw new ValidationError(HttpStatus.CONFLICT, {message: 'Modification history mismatch (CAT)'});
  }
  logger.debug(`validateRecordState: OK`);
}

