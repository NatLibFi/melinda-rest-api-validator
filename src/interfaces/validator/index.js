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
import {MarcRecord} from '@natlibfi/marc-record';
import matchValidation from './match-validation-mock';
import merger from './merge-mock';
import matcherService from './match';

//import createDebugLogger from 'debug';

//const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator');
//const debugData = debug.extend('data');

export default async function ({formatOptions, sruUrl, matchOptionsList}) {
  const logger = createLogger();
  const {formatRecord} = format;
  // validationService: marc-record-validate validations from melinda-rest-api-commons
  const validationService = await validations();
  const ConversionService = conversions();
  // should we have here matcherService?
  const matchers = matchOptionsList.map(matchOptions => createMatchInterface(matchOptions));
  const sruClient = createSruClient({url: sruUrl, recordSchema: 'marcxml', retrieveAll: false, maximumRecordsPerRequest: 1});

  return {process};

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
    const merge = headers.merge || undefined;

    const record = await unserializeAndFormatRecord(data, format, formatOptions);
    logger.silly(record);

    // All other validations result in errors when they fail, only validationService returns result.failed
    // validation result from validationService: {record, failed, messages: []}

    if (noop) {
      return processNoop();
    }
    return processNormal();

    async function processNoop() {

      // How should merge-noops be handled?

      logger.debug(`validator/index/process: Add status to noop`);
      const result = {
        status: operation === 'CREATE' ? 'CREATED' : 'UPDATED',
        ...await executeValidations()
      };
      logger.silly(`validator/index/process: Validation result for noop: ${inspect(result, {colors: true, maxArrayLength: 3, depth: 1})}`);
      logger.debug(`return result for noop`);
      return result;
    }

    async function processNormal() {
      logger.silly(`validator/index/process: Running validations for normal`);
      const result = await executeValidations();

      logger.silly(`validator/index/process: Validation result for non-noop: ${inspect(result, {colors: true, maxArrayLength: 3, depth: 1})}`);

      // throw ValidationError for failed validationService for non-noop
      if (result.failed) { // eslint-disable-line functional/no-conditional-statement
        logger.debug('Validation failed');
        throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, result.messages);
      }

      return {headers: {operation, cataloger: cataloger.id}, data: result.record.toObject()};
    }

    async function unserializeAndFormatRecord(data, format, formatOptions) {
      try {
        logger.silly(`Data: ${JSON.stringify(data)}`);
        logger.silly(`Format: ${format}`);
        const unzerialized = await ConversionService.unserialize(data, format);
        logger.silly(`Unserialized data: ${JSON.stringify(unzerialized)}`);
        const recordObject = await formatRecord(unzerialized, formatOptions);
        logger.silly(`Formated recordObject:\n${JSON.stringify(recordObject)}`);
        return new MarcRecord(recordObject, {subfieldValues: false});
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

      // merge for updates

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

        logger.debug(`There are ${matchers.length} matchers with matchOptions: ${JSON.stringify(matchOptionsList)}`);

        // This should use different matchOptions for merge and non-merge cases

        const matchResults = await matcherService.iterateMatchersUntilMatchIsFound({matchers, matchOptionsList, updatedRecord});
        logger.verbose(JSON.stringify(matchResults));
        // eslint-disable-next-line functional/no-conditional-statement
        if (matchResults.length > 0 && !merge) {
          throw new ValidationError(HttpStatus.CONFLICT, {message: 'Duplicates in database', ids: matchResults.map(({candidate: {id}}) => id)});
        }

        // eslint-disable-next-line functional/no-conditional-statement
        if (matchResults.length > 0 && merge) {
          logger.debug(`Found matches (${matchResults.length} for merging)`);
          return mergeMatchResults(matchResults);
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

    function mergeMatchResults(matchResults) {
      logger.debug(`We have matchResults here: ${JSON.stringify(matchResults)}`);

      // run matchValidation for record & matchResults
      // run merge based on matchValidation results

      matchValidation();

      const mergeRequest = {
        base: record,
        source: matchResults[0].candidate.record
      };

      merger(mergeRequest);
      throw new ValidationError(HttpStatus.CONFLICT, {message: 'Duplicates in database, merge flag true, cannot merge yet', ids: matchResults.map(({candidate: {id}}) => id)});
    }
  }


  // Checks that the modification history is identical
  function validateRecordState(incomingRecord, existingRecord) {
    const logger = createLogger();
    const incomingModificationHistory = Array.isArray(incomingRecord) ? incomingRecord : incomingRecord.get(/^CAT$/u);
    const existingModificationHistory = existingRecord.get(/^CAT$/u) || [];

    // Merge makes uuid variables to all fields and this removes those
    const incomingModificationHistoryNoUuids = incomingModificationHistory.map(field => ({tag: field.tag, ind1: field.ind1, ind2: field.ind2, subfields: field.subfields}));

    logger.silly(`Incoming CATS:\n${JSON.stringify(incomingModificationHistoryNoUuids)}`);
    logger.silly(`Existing CATS:\n${JSON.stringify(existingModificationHistory)}`);

    if (deepEqual(incomingModificationHistoryNoUuids, existingModificationHistory) === false) { // eslint-disable-line functional/no-conditional-statement
      throw new ValidationError(HttpStatus.CONFLICT, {message: 'Modification history mismatch (CAT)'});
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

