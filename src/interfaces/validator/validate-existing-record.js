import createDebugLogger from 'debug';
import httpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ValidationError, isDeletedRecord} from '@natlibfi/melinda-commons';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:validate-existing-record');
const debugData = debug.extend('data');
const logger = createLogger();

export function validateExistingRecord(existingRecord, recordMetadata, validate) {

  if (validate === false) {
    logger.debug(`Skipping validateExistingRecord, validate: ${validate}`);
    return 'skipped';
  }

  debugData(`Existing record:\n ${existingRecord}`);

  const isDeleted = isDeletedRecord(existingRecord);


  if (isDeleted) {
    logger.verbose('Existing record is deleted!');
    debug('Existing record is deleted!');
    throw new ValidationError(httpStatus.NOT_FOUND, {message: `Existing record is deleted`, recordMetadata});
  }

  logger.debug('Existing record is not deleted.');
  debug('Existing record is not deleted.');
}
