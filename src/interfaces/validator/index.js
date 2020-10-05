import deepEqual from 'deep-eql';
import HttpStatus from 'http-status';
import {isArray} from 'util';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ValidationError} from '@natlibfi/melinda-commons';
import {validations, conversions, format, OPERATIONS} from '@natlibfi/melinda-rest-api-commons';
import createSruClient from '@natlibfi/sru-client';
import createMatchInterface from '@natlibfi/melinda-record-matching';
import validateOwnChanges from './own-authorization';
import {updateField001ToParamId} from '../../utils';

export default async function ({formatOptions, sruUrl, matchOptions}) {
  const logger = createLogger();
  const {formatRecord} = format;
  const validationService = await validations();
  const ConversionService = conversions();
  const match = createMatchInterface(matchOptions);
  const sruClient = createSruClient({url: sruUrl, recordSchema: 'marcxml', retrieveAll: false, maximumRecordsPerRequest: 1});

  return {process};

  async function process(headers, data) {
    logger.log('debug', `process headers ${JSON.stringify(headers)}`);
    const {
      operation,
      format,
      cataloger,
      noop
    } = headers;
    const id = headers.id || undefined;
    const unique = headers.unique || undefined;

    logger.log('silly', `Data: ${JSON.stringify(data)}`);
    logger.log('silly', `Format: ${format}`);
    const unzerialized = await ConversionService.unserialize(data, format);
    logger.log('silly', `Unserialized data: ${JSON.stringify(unzerialized)}`);
    const record = await formatRecord(unzerialized, formatOptions);
    logger.log('silly', `Formated record:\n${JSON.stringify(record)}`);

    if (noop) {
      const result = {
        status: operation === 'CREATE' ? 'CREATED' : 'UPDATED',
        ...await executeValidations()
      };
      return result;
    }
    const result = await executeValidations();

    if (result.failed) { // eslint-disable-line functional/no-conditional-statement
      logger.log('debug', 'Validation failed');
      throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, result.messages);
    }

    return {headers: {operation, cataloger: cataloger.id}, data: result.record.toObject()};

    function executeValidations() {
      logger.log('verbose', 'Validating the record');

      if (operation === OPERATIONS.UPDATE) {
        return updateValidations();
      }

      return createValidations();
    }

    async function updateValidations() {
      logger.log('verbose', 'Validations for UPDATE operation');
      if (id) {
        const updatedRecord = updateField001ToParamId(`${id}`, record);
        logger.log('silly', `Updated record:\n${JSON.stringify(updatedRecord)}`);

        logger.log('verbose', `Reading record ${id} from SRU`);
        const existingRecord = await getRecord(id);
        logger.log('silly', `Record from SRU: ${JSON.stringify(existingRecord)}`);

        logger.log('verbose', 'Checking LOW-tag authorization');
        validateOwnChanges(cataloger.authorization, updatedRecord, existingRecord);

        logger.log('verbose', 'Checking CAT field history');
        validateRecordState(updatedRecord, existingRecord);

        const validationResults = await validationService(updatedRecord);
        return validationResults;
      }

      logger.log('debug', 'No id in headers');
      throw new ValidationError(HttpStatus.BAD_REQUEST, 'Update id missing!');
    }

    async function createValidations() {
      logger.log('verbose', 'Validations for CREATE operation');
      const updatedRecord = updateField001ToParamId('1', record);
      logger.log('silly', `Updated record:\n${JSON.stringify(updatedRecord)}`);

      logger.log('verbose', 'Checking LOW-tag authorization');
      await validateOwnChanges(cataloger.authorization, updatedRecord);

      if (unique) {
        logger.log('verbose', 'Attempting to find matching records in the SRU');
        const matchResults = await match(updatedRecord);

        if (matchResults.length > 0) { // eslint-disable-line functional/no-conditional-statement
          logger.log('debug', 'Matching record has been found');
          logger.log('silly', JSON.stringify(matchResults.map(({candidate: {id}, probability}) => ({id, probability}))));
          throw new ValidationError(HttpStatus.CONFLICT, matchResults.map(({candidate: {id}}) => id));
        }

        const validationResults = await validationService(updatedRecord);
        return validationResults;
      }

      const validationResults = await validationService(updatedRecord);
      return validationResults;
    }
  }

  // Checks that the modification history is identical
  function validateRecordState(incomingRecord, existingRecord) {
    const incomingModificationHistory = isArray(incomingRecord) ? incomingRecord : incomingRecord.get(/^CAT$/u);
    const existingModificationHistory = existingRecord.get(/^CAT$/u) || [];

    // Merge makes uuid variables to all fields and this removes those
    const incomingModificationHistoryNoUuids = incomingModificationHistory.map(field => { // eslint-disable-line arrow-body-style
      return {tag: field.tag, ind1: field.ind1, ind2: field.ind2, subfields: field.subfields};
    });

    logger.log('silly', `Incoming CATS:\n${JSON.stringify(incomingModificationHistoryNoUuids)}`);
    logger.log('silly', `Existing CATS:\n${JSON.stringify(existingModificationHistory)}`);

    if (deepEqual(incomingModificationHistoryNoUuids, existingModificationHistory) === false) { // eslint-disable-line functional/no-conditional-statement
      throw new ValidationError(HttpStatus.CONFLICT, 'Modification history mismatch (CAT)');
    }
  }

  function getRecord(id) {
    return new Promise((resolve, reject) => {
      let promise; // eslint-disable-line functional/no-let

      sruClient.searchRetrieve(`rec.id=${id}`)
        .on('record', xmlString => {
          promise = MARCXML.from(xmlString, {subfieldValues: false});
        })
        .on('end', async () => {
          if (promise) {
            try {
              const record = await promise;
              resolve(record);
            } catch (err) {
              reject(err);
            }

            logger.log('debug', 'No record promise from sru');
            return;
          }

          resolve();
        })
        .on('error', err => reject(err));
    });
  }
}
