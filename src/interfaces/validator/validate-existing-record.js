import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ValidationError, isDeletedRecord} from '@natlibfi/melinda-commons';
import httpStatus from 'http-status';
import createDebugLogger from 'debug';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:validate-existing-record');
const debugData = debug.extend('data');

export function validateExistingRecord(existingRecord) {
  const logger = createLogger();

  debugData(`Existing record:\n ${existingRecord}`);

  const isDeleted = isDeletedRecord(existingRecord);

  // eslint-disable-next-line functional/no-conditional-statement
  if (isDeleted) {
    logger.log('verbose', 'Existing record is deleted!');
    debug('Existing record is deleted!');
    throw new ValidationError(httpStatus.NOT_FOUND, 'Existing record is deleted');
  }

  logger.log('debug', 'Existing record is not deleted.');
  debug('Existing record is not deleted.');
}
