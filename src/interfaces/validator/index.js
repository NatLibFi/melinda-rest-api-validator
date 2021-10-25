import deepEqual from 'deep-eql';
import HttpStatus from 'http-status';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ValidationError} from '@natlibfi/melinda-commons';
import {validations, conversions, format, OPERATIONS, logError} from '@natlibfi/melinda-rest-api-commons';
import createSruClient from '@natlibfi/sru-client';
import createMatchInterface from '@natlibfi/melinda-record-matching';
import validateOwnChanges from './own-authorization';
import {updateField001ToParamId} from '../../utils';
import {validateExistingRecord} from './validate-existing-record';
import {inspect} from 'util';

export default async function ({formatOptions, sruUrl, matchOptions}) {
  const logger = createLogger();
  const {formatRecord} = format;
  // validationService: marc-record-validate validations from melinda-rest-api-commons
  const validationService = await validations();
  const ConversionService = conversions();
  const match = createMatchInterface(matchOptions);
  const sruClient = createSruClient({url: sruUrl, recordSchema: 'marcxml', retrieveAll: false, maximumRecordsPerRequest: 1});

  return {process};

  // eslint-disable-next-line max-statements
  async function process(headers, data) {
    logger.debug(`process headers ${JSON.stringify(headers)}`);

    const {
      operation,
      format,
      cataloger,
      noop
    } = headers;
    const id = headers.id || undefined;
    const unique = headers.unique || undefined;

    const record = await unserializeAndFormatRecord(data, format, formatOptions);
    logger.silly(record);

    // All other validations result in errors when they fail, only validationService returns result.failed
    // validation result from validationService: {record, failed, messages: []}

    if (noop) {
      logger.debug(`validator/index/process: Add status to noop`);
      const result = {
        status: operation === 'CREATE' ? 'CREATED' : 'UPDATED',
        ...await executeValidations()
      };
      logger.silly(`validator/index/process: Validation result for noop: ${inspect(result, {colors: true, maxArrayLength: 3, depth: 1})}`);
      logger.debug(`return result for noop`);
      return result;
    }

    // non-noop
    const result = await executeValidations();
    logger.silly(`validator/index/process: Validation result for non-noop: ${inspect(result, {colors: true, maxArrayLength: 3, depth: 1})}`);

    // throw ValidationError for failed validationService for non-noop
    if (result.failed) { // eslint-disable-line functional/no-conditional-statement
      logger.debug('Validation failed');
      throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, result.messages);
    }

    return {headers: {operation, cataloger: cataloger.id}, data: result.record.toObject()};

    async function unserializeAndFormatRecord(data, format, formatOptions) {
      try {
        logger.silly(`Data: ${JSON.stringify(data)}`);
        logger.silly(`Format: ${format}`);
        const unzerialized = await ConversionService.unserialize(data, format);
        logger.silly(`Unserialized data: ${JSON.stringify(unzerialized)}`);
        const record = await formatRecord(unzerialized, formatOptions);
        logger.silly(`Formated record:\n${JSON.stringify(record)}`);
        return record;
      } catch (err) {
        logger.debug(`unserializeAndFormatRecord errored:`);
        logError(err);
        const cleanErrorMessage = err.message.replace(/(?<lineBreaks>\r\n|\n|\r)/gmu, ' ');
        //logger.silly(`${cleanErrorMessage}`);
        throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, `Parsing input data failed. ${cleanErrorMessage}`);
      }
    }

    function executeValidations() {
      logger.verbose('Validating the record');

      if (operation === OPERATIONS.UPDATE) {
        return updateValidations();
      }

      return createValidations();
    }

    async function updateValidations() {
      logger.verbose('Validations for UPDATE operation');
      if (id) {
        const updatedRecord = updateField001ToParamId(`${id}`, record);
        logger.silly(`Updated record:\n${JSON.stringify(updatedRecord)}`);

        logger.verbose(`Reading record ${id} from SRU`);
        const existingRecord = await getRecord(id);
        logger.silly(`Record from SRU: ${JSON.stringify(existingRecord)}`);

        if (!existingRecord) {
          logger.debug(`Record ${id} was not found from SRU.`);
          throw new ValidationError(HttpStatus.NOT_FOUND, `Cannot find record ${id} to update`);
        }

        // aleph-record-load-api cannot currently update a record if the existing record is deleted
        logger.verbose('Checking whether the existing record is deleted');
        validateExistingRecord(existingRecord);

        logger.verbose('Checking LOW-tag authorization');
        validateOwnChanges(cataloger.authorization, updatedRecord, existingRecord);

        logger.verbose('Checking CAT field history');
        validateRecordState(updatedRecord, existingRecord);

        // Note validationService = validation.js from melinda-rest-api-commons
        // which uses marc-record-validate
        // currently checks only that possible f003 has value FI-MELINDA
        // for some reason this does not work for noop CREATEs

        const validationResults = await validationService(updatedRecord);
        return validationResults;
      }

      logger.debug('No id in headers');
      throw new ValidationError(HttpStatus.BAD_REQUEST, 'Update id missing!');
    }

    async function createValidations() {
      logger.verbose('Validations for CREATE operation');
      const updatedRecord = updateField001ToParamId('1', record);
      logger.silly(`Updated record:\n${JSON.stringify(updatedRecord)}`);

      logger.verbose('Checking LOW-tag authorization');
      await validateOwnChanges(cataloger.authorization, updatedRecord);

      if (unique) {
        logger.verbose('Attempting to find matching records in the SRU');
        const matchResults = await match(updatedRecord);

        if (matchResults.length > 0) { // eslint-disable-line functional/no-conditional-statement
          logger.verbose('Matching record has been found');
          logger.silly(JSON.stringify(matchResults.map(({candidate: {id}, probability}) => ({id, probability}))));
          throw new ValidationError(HttpStatus.CONFLICT, matchResults.map(({candidate: {id}}) => id));
        }

        logger.verbose('No matching records');

        // Note validationService = validation.js from melinda-rest-api-commons
        // which uses marc-record-validate
        // currently checks only that possible f003 has value FI-MELINDA
        // for some reason this does not work for noop CREATEs

        const validationResults = await validationService(updatedRecord);
        return validationResults;
      }

      const validationResults = await validationService(updatedRecord);
      return validationResults;
    }
  }

  // Checks that the modification history is identical
  function validateRecordState(incomingRecord, existingRecord) {
    const logger = createLogger();
    const incomingModificationHistory = Array.isArray(incomingRecord) ? incomingRecord : incomingRecord.get(/^CAT$/u);
    const existingModificationHistory = existingRecord.get(/^CAT$/u) || [];

    // Merge makes uuid variables to all fields and this removes those
    const incomingModificationHistoryNoUuids = incomingModificationHistory.map(field => { // eslint-disable-line arrow-body-style
      return {tag: field.tag, ind1: field.ind1, ind2: field.ind2, subfields: field.subfields};
    });

    logger.silly(`Incoming CATS:\n${JSON.stringify(incomingModificationHistoryNoUuids)}`);
    logger.silly(`Existing CATS:\n${JSON.stringify(existingModificationHistory)}`);

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

            //logger.debug('No record promise from sru');
            return;
          }

          resolve();
        })
        .on('error', err => reject(err));
    });
  }
}


