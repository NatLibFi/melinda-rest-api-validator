import httpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ValidationError} from '@natlibfi/melinda-commons';
import createSruClient from '@natlibfi/sru-client';
import {validateExistingRecord} from './validate-existing-record.js';
import {getRecord} from '../../utils.js';

const logger = createLogger();

export function fixValidationsFactory(mongoLogOperator, {sruUrl}) {
  logger.debug(`Creating fixValidations. sruUrl: ${sruUrl}}`);
  const sruClient = createSruClient({url: sruUrl, recordSchema: 'marcxml', retrieveAll: false, maximumRecordsPerRequest: 1});

  return {fixValidations};

  async function fixValidations({headers}) {
    const {operationSettings, id, correlationId} = headers;
    const {fixType, validate} = operationSettings;

    logger.verbose(`Validations for FIX operation (${fixType}) ${id} for ${correlationId}`);
    logger.debug(`fixValidation, headers (${JSON.stringify(headers)})`);

    // Currently also melinda-api-http forces all validations (validate=true) for prio and batchBulk
    const runValidations = validate || true;

    logger.verbose(`Reading record ${id} from SRU for ${correlationId}`);
    const existingRecord = await getRecord(sruClient, id);
    logger.silly(`Record from SRU: ${JSON.stringify(existingRecord)}`);

    if (!existingRecord) {
      logger.debug(`Record ${id} was not found from SRU.`);
      throw new ValidationError(httpStatus.NOT_FOUND, {message: `Cannot find record ${id} to fix`});
    }

    if (fixType !== 'UNDEL') {
      // We don't want to fix deleted records unless our fix is UNDEL
      logger.verbose('Checking whether the existing record is deleted');
      validateExistingRecord(existingRecord, {}, runValidations);
      return {result: true, recordMetadata: {}, headers};
    }

    return {result: true, recordMetadata: {}, headers};
  }
}
