/* eslint-disable max-statements */
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
import createDebugLogger from 'debug';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator');
const debugData = debug.extend('data');

export default async function ({formatOptions, sruUrl, matchOptionsList}) {
  const logger = createLogger();
  const {formatRecord} = format;
  const validationService = await validations();
  const ConversionService = conversions();
  const matchers = matchOptionsList.map(matchOptions => createMatchInterface(matchOptions));

  // This sruClient is used for fetching record for checking its existence and LOW/CAT-validations, matchers use their own sruClient
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

      // Note: If new records created in Merge UI are created through REST, LOW authorization needs to be skippable
      logger.log('verbose', 'Checking LOW-tag authorization');
      await validateOwnChanges(cataloger.authorization, updatedRecord);

      if (unique) {
        logger.log('verbose', 'Attempting to find matching records in the SRU');

        // Currently run first matcher in matchers, needs to be updated to run them all
        debugData(`Using matchOptions: ${JSON.stringify(matchOptionsList[0])}`);
        const matchResults = await matchers[0](updatedRecord);

        if (matchResults.length > 0) { // eslint-disable-line functional/no-conditional-statement
          logger.log('verbose', 'Matching record has been found');
          logger.log('silly', JSON.stringify(matchResults.map(({candidate: {id}, probability}) => ({id, probability}))));
          throw new ValidationError(HttpStatus.CONFLICT, matchResults.map(({candidate: {id}}) => id));
        }

        logger.log('verbose', 'No matching records');

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

    logger.log('silly', `Incoming CATS (${incomingModificationHistoryNoUuids.length}):\n${JSON.stringify(incomingModificationHistoryNoUuids)}`);
    logger.log('silly', `Existing CATS (${existingModificationHistory.length}):\n${JSON.stringify(existingModificationHistory)}`);

    if (deepEqual(incomingModificationHistoryNoUuids, existingModificationHistory) === false) { // eslint-disable-line functional/no-conditional-statement
      throw new ValidationError(HttpStatus.CONFLICT, 'Modification history mismatch (CAT)');
    }
  }

  // Note: getRecord(id) is trustworthy only if used search will not return more than one record!
  // Note2: sruClient has been configured to return max 1 result
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
              logger.log('debug', 'Solving record promise from SRU');
              const record = await promise;
              logger.log('silly', `Record: ${JSON.stringify(record)}`);
              resolve(record);
            } catch (err) {
              reject(err);
            }
            return;
          }
          logger.log('debug', 'No record promise from SRU');
          reject(new ValidationError(HttpStatus.NOT_FOUND, 'Record to update not found'));
        })
        .on('error', err => reject(err));
    });
  }
}
