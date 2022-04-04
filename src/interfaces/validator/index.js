import HttpStatus from 'http-status';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ValidationError} from '@natlibfi/melinda-commons';
import {validations, conversions, format, OPERATIONS, logError} from '@natlibfi/melinda-rest-api-commons';
import createSruClient from '@natlibfi/sru-client';
import validateOwnChanges from './own-authorization';
import {updateField001ToParamId, getRecordMetadata} from '../../utils';
import {validateExistingRecord} from './validate-existing-record';
import {inspect} from 'util';
import {MarcRecord} from '@natlibfi/marc-record';
import {matchValidationForMatchResults} from './match-validation-mock';
import merger from './merge-mock';
import * as matcherService from './match';
import createMatchInterface from '@natlibfi/melinda-record-matching';
import {validateRecordState} from './validate-record-state';
import {detailedDiff} from 'deep-object-diff';

//import createDebugLogger from 'debug';

//const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator');
//const debugData = debug.extend('data');

export default async function ({formatOptions, sruUrl, matchOptionsList}) {
  const logger = createLogger();
  // format: format record to Melinda/Aleph internal format ($w(FI-MELINDA) -> $w(FIN01) etc.)
  const {formatRecord} = format;
  // validationService: marc-record-validate validations from melinda-rest-api-commons
  const validationService = await validations();
  const ConversionService = conversions();
  // should we have here matcherService? commons mongo/amqp
  const matchers = matchOptionsList.map(matchOptions => createMatchInterface(matchOptions));
  const sruClient = createSruClient({url: sruUrl, recordSchema: 'marcxml', retrieveAll: false, maximumRecordsPerRequest: 1});

  return {process};

  // eslint-disable-next-line max-statements
  async function process(headers, data) {
    const {operationSettings} = headers;
    logger.debug(`process headers ${JSON.stringify(headers)}`);

    logger.debug(`Data is in format: ${headers.format}, prio: ${operationSettings.prio}, noStream: ${operationSettings.noStream}`);
    const record = headers.operationSettings.prio || headers.format || headers.operationSettings.noStream ? await unserializeAndFormatRecord(data, headers.format, formatOptions) : new MarcRecord(formatRecord(data, formatOptions));

    logger.verbose(`Creating recordMetadata`);
    const recordMetadata = headers.recordMetadata ? headers.recordMetadata : getRecordMetadata(record);
    logger.verbose(`${JSON.stringify(recordMetadata)}`);

    const newHeaders = {
      recordMetadata,
      ...headers
    };

    logger.verbose(`${JSON.stringify(newHeaders)}`);

    return processNormal({record, headers: newHeaders});

    async function processNormal({record, headers}) {
      logger.silly(`validator/index/process: Running validations for normal (${headers.sourceId})`);

      try {
        const {result, operationAfterValidation, mergeValidationResult} = await executeValidations({record, headers});

        // If the incoming record was merged in the validationProcess, update operation to 'UPDATE'
        const newOperation = operationAfterValidation === 'updateAfterMerge' ? 'UPDATE' : operationAfterValidation;

        logger.debug(`validator/index/process: Validation result: ${inspect(result, {colors: true, maxArrayLength: 3, depth: 1})}`);
        logger.debug(`validator/index/process: operationAfterValidation: ${operationAfterValidation}, newOperation: ${newOperation}, original operation: ${headers.operation}`);
        logger.debug(`validator/index/process: mergeValidationResult: ${mergeValidationResult}`);

        // throw ValidationError for failed validationService
        if (result.failed) { // eslint-disable-line functional/no-conditional-statement
          logger.debug('Validation failed');
          throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, result.messages);
        }

        // should we have operationSettings header here?
        const newHeaders = {
          operation: newOperation,
          ...headers
        };
        return {headers: newHeaders, data: result.record.toObject(), mergeValidationResult};

      } catch (err) {
        logger.debug(`processNormal: validation errored: ${JSON.stringify(err)}`);
        if (err instanceof ValidationError) {
          throw new ValidationError(err.status, err.payload);
        }
        throw new Error(err);
      }
    }

    async function unserializeAndFormatRecord(data, format, formatOptions, recordMetadata) {
      try {
        logger.silly(`Data: ${JSON.stringify(data)}`);
        logger.silly(`Format: ${format}`);
        const unzerialized = await ConversionService.unserialize(data, format);
        logger.silly(`Unserialized data: ${JSON.stringify(unzerialized)}`);
        // Format record - currently for bibs edit $0 and $w ISILs to Aleph internar library codes
        const recordObject = await formatRecord(unzerialized, formatOptions);
        logger.silly(`Formated recordObject:\n${JSON.stringify(recordObject)}`);
        return new MarcRecord(recordObject, {subfieldValues: false});
      } catch (err) {
        logger.debug(`unserializeAndFormatRecord errored:`);
        logError(err);
        const cleanErrorMessage = err.message.replace(/(?<lineBreaks>\r\n|\n|\r)/gmu, ' ');
        //logger.silly(`${cleanErrorMessage}`);
        throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, {message: `Parsing input data failed. ${cleanErrorMessage}`, recordMetadata});
      }
    }

    function executeValidations({record, headers}) {
      logger.verbose('Validating the record');

      if (headers.operation === OPERATIONS.UPDATE) {
        return updateValidations({updateId: headers.id, updateRecord: record, updateOperation: headers.operation, headers});
      }

      return createValidations({record, headers});
    }

    // eslint-disable-next-line max-statements
    async function updateValidations({updateId, updateRecord, updateOperation, mergeValidationResult = undefined, headers}) {
      logger.verbose(`Validations for UPDATE operation (${updateOperation})`);
      logger.verbose(`MergeValidationResult: ${mergeValidationResult}`);
      logger.debug(`UpdateId: ${JSON.stringify(updateId)}`);
      //logger.debug(JSON.stringify(updateRecord));

      if (updateId) {
        const updatedRecord = updateField001ToParamId(`${updateId}`, updateRecord);
        logger.silly(`Updated record:\n${JSON.stringify(updatedRecord)}`);

        logger.verbose(`Reading record ${updateId} from SRU`);
        const existingRecord = await getRecord(updateId);
        logger.silly(`Record from SRU: ${JSON.stringify(existingRecord)}`);

        if (!existingRecord) {
          logger.debug(`Record ${updateId} was not found from SRU.`);
          throw new ValidationError(HttpStatus.NOT_FOUND, {message: `Cannot find record ${updateId} to update`, recordMetadata});
        }

        const formattedExistingRecord = formatRecord(existingRecord, formatOptions);
        logger.silly(`Formatted record from SRU: ${JSON.stringify(formattedExistingRecord)}`);

        // aleph-record-load-api cannot currently update a record if the existing record is deleted
        logger.verbose('Checking whether the existing record is deleted');
        validateExistingRecord(existingRecord);

        // Merge for updates (do not run if record is already merged CREATE)
        logger.debug(`Check whether merge is needed for update`);
        logger.debug(`headers: ${headers}, updateOperation: ${updateOperation}`);
        const updateMergeNeeded = headers.operationSettings.merge && updateOperation !== 'updateAfterMerge';
        const {mergedRecord: updatedRecordAfterMerge, mergeValidationResult: mergeValidationResultAfterMerge} = updateMergeNeeded ? await mergeRecordForUpdates({record: updatedRecord, existingRecord, id: updateId}) : {mergedRecord: updatedRecord, mergeValidationResult};

        // eslint-disable-next-line functional/no-conditional-statement
        if (updateMergeNeeded) {
          logger.debug(`We needed merge for UPDATE: ${updateMergeNeeded}`);
          logger.debug(`Original incoming record: ${updatedRecord}`);
          logger.debug(`Incoming record after merge: ${updatedRecordAfterMerge}`);
          // get here diff for records
          logger.debug(`Changes merge makes to existing record: ${inspect(detailedDiff(existingRecord, updatedRecordAfterMerge), {colors: true, depth: 5})}`);
          //logger.debug(`Changes merge makes to incoming record: ${inspect(detailedDiff(updatedRecord, updatedRecordAfterMerge), {colors: true, depth: 5})}`);
        }

        // bulk does not have cataloger.authorization
        // eslint-disable-next-line functional/no-conditional-statement
        if (headers.cataloger.authorization) {
          logger.verbose('Checking LOW-tag authorization');
          validateOwnChanges(headers.cataloger.authorization, updatedRecordAfterMerge, existingRecord, recordMetadata);
        // eslint-disable-next-line functional/no-conditional-statement
        } else {
          logger.verbose(`No cataloger.authorization available for checking LOW-tags`);
        }

        logger.verbose('Checking CAT field history');
        validateRecordState(updatedRecordAfterMerge, existingRecord, recordMetadata);

        // Note validationService = validation.js from melinda-rest-api-commons
        // which uses marc-record-validate
        // currently checks only that possible f003 has value FI-MELINDA
        // for some reason this does not work for noop CREATEs

        //const mergeValidationResult = updateOperation === 'merge' ? {merged: true, mergedId: updateId} : {merged: false};
        logger.debug(`mergeValidationResult: ${JSON.stringify(mergeValidationResult)}`);
        const validationResults = await validationService(updatedRecordAfterMerge);
        return {result: validationResults, operationAfterValidation: updateOperation, mergeValidationResult: mergeValidationResultAfterMerge};
      }

      logger.debug('No id in headers / merge results');
      throw new ValidationError(HttpStatus.BAD_REQUEST, {message: 'Update id missing!', recordMetadata: headers.recordMetadata});
    }

    // eslint-disable-next-line max-statements
    async function createValidations({record, headers}) {
      const {recordMetadata, cataloger, operationSettings, operation} = headers;

      logger.verbose(`Validations for CREATE operation. Unique: ${operationSettings.unique}, merge: ${operationSettings.merge}`);

      // Do we need this? - nope - bulk with this update puts all records to the same AlephSequential!
      //const updatedRecord = updateField001ToParamId('1', record);
      //logger.silly(`Updated record:\n${JSON.stringify(updatedRecord)}`);

      // bulks do not have cataloger.authorization
      // eslint-disable-next-line functional/no-conditional-statement
      if (cataloger.authorization) {
        logger.verbose('Checking LOW-tag authorization');
        validateOwnChanges(cataloger.authorization, record, recordMetadata);
      // eslint-disable-next-line functional/no-conditional-statement
      } else {
        logger.verbose(`No cataloger.authorization available for checking LOW-tags`);
      }

      if (operationSettings.unique) {
        logger.verbose('Attempting to find matching records in the SRU');

        logger.debug(`There are ${matchers.length} matchers with matchOptions: ${JSON.stringify(matchOptionsList)}`);
        // This should use different matchOptions for merge and non-merge cases
        // Note: incoming record is formatted ($w(FIN01)), existing records from SRU are not ($w(FI-MELINDA))
        const matchResults = await matcherService.iterateMatchersUntilMatchIsFound({matchers, matchOptionsList, record});
        logger.debug(JSON.stringify(matchResults.map(({candidate: {id}, probability}) => ({id, probability}))));
        // eslint-disable-next-line functional/no-conditional-statement
        if (matchResults.length > 0 && !operationSettings.merge) {
          //const errorMessage = JSON.stringify({message: 'Duplicates in database', ids: matchResults.map(({candidate: {id}}) => id)});
          const errorPayload = {message: 'Duplicates in database', ids: matchResults.map(({candidate: {id}}) => id), recordMetadata};
          throw new ValidationError(HttpStatus.CONFLICT, errorPayload);
        }

        // eslint-disable-next-line functional/no-conditional-statement
        if (matchResults.length > 0 && operationSettings.merge) {
          logger.debug(`Found matches (${matchResults.length}) for merging.`);
          return validateAndMergeMatchResults(record, matchResults, formatOptions, recordMetadata);
        }

        logger.verbose('No matching records');

        // Note validationService = validation.js from melinda-rest-api-commons
        // which uses marc-record-validate
        // currently checks only that possible f003 has value FI-MELINDA
        // for some reason this does not work for noop CREATEs

        const validationResults = await validationService(record);
        return {result: validationResults, operationAfterValidation: operation, recordMetadata};
      }

      logger.debug('No unique');
      const validationResults = await validationService(record);
      return {result: validationResults, operationAfterValidation: operation, recordMetadata};
    }

    async function validateAndMergeMatchResults(record, matchResults, formatOptions, recordMetadata) {
      try {
        logger.debug(`We have matchResults (${matchResults.length}) here: ${JSON.stringify(matchResults.map(({candidate: {id}, probability}) => ({id, probability})))}`);
        logger.silly(` ${JSON.stringify(matchResults)}`);

        // run matchValidation for record & matchResults
        // -> choose the best possible match
        // -> if none of the matches are valid, what to do?

        // Is the match mergeable?
        // Which of the records should be preferred

        const matchValidationResults = await matchValidationForMatchResults(record, matchResults, formatOptions);
        logger.debug(`MatchValidationResults: ${inspect(matchValidationResults, {colors: true, maxArrayLength: 3, depth: 2})}}`);

        // We should check all results?
        const [firstResult] = matchValidationResults.matchResultsAndMatchValidations;

        logger.debug(`firstResult: ${inspect(firstResult, {colors: true, maxArrayLength: 3, depth: 2})}}`);

        if (firstResult.matchValidationResult.action === false) {
          throw new ValidationError(HttpStatus.CONFLICT, {message: `MatchValidation failed. ${firstResult.message}`, recordMetadata});
        }
        logger.debug(firstResult.matchValidationResult.action);
        logger.debug(`Action from matchValidation: ${firstResult.matchValidationResult.action}`);


        // Note this does not do anything about matchValidationResults yet
        return mergeValidatedMatchResults(record, matchResults, recordMetadata);
      } catch (err) {
        logger.debug(`MatchValidation errored`);
        logger.error(err);
        throw err;
      }
    }

    async function mergeValidatedMatchResults(record, matchResults, recordMetadata) {

      logger.debug(record);
      logger.debug(matchResults);

      // run merge based on matchValidation results

      // base = preferred record, in this case the matching datastore record
      // source = non-preferred record, in this case the incoming record

      const mergeRequest = {
        source: record,
        sourceId: undefined,
        base: matchResults[0].candidate.record,
        baseId: matchResults[0].candidate.id
      };

      logger.debug(inspect(mergeRequest));

      try {

        // mergeResult.id: recordId in the database to be updated with the merged record
        // mergeResult.record: merged record that can be used to update the database record
        // mergeResult.report: report from merge -> to be saved to mongo etc
        // mergeResult.status: true
        // mergeResult.error: possible errors

        const mergeResult = await merger(mergeRequest);
        return handleMergeResult(mergeResult, matchResults);

      } catch (err) {
        logger.debug(`mergeMatchResults errored:`);

        // if error was about merging try the next best valid match
        // -> if all matches error merging semantically?

        logError(err);
        throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, {message: `Merge errored`, recordMetadata});
        // throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, `Parsing input data failed. ${cleanErrorMessage}`);
      }
    }

    async function mergeRecordForUpdates({record, existingRecord, id}) {
      logger.debug(`Merging updated record ${id} to existing record ${id}`);
      const mergeRequest = {
        source: record,
        sourceId: id,
        base: existingRecord,
        baseId: id
      };

      // mergeResult.id: recordId in the database to be updated with the merged record
      // mergeResult.record: merged record that can be used to update the database record
      // mergeResult.report: report from merge -> to be saved to mongo etc
      // mergeResult.status: true
      // mergeResult.error: possible errors

      const mergeResult = await merger(mergeRequest);
      logger.debug(JSON.stringify(mergeResult));
      const mergeValidationResult = {merged: true, mergedId: id};
      return {mergedRecord: new MarcRecord(mergeResult.record, {subfieldValues: false}), mergeValidationResult};
    }

    function handleMergeResult(mergeResult, recordMetadata) {

      logger.debug(`Got mergeResult: ${JSON.stringify(mergeResult)}`);
      const mergeValidationResult = {merged: mergeResult.status, mergedId: mergeResult.id};

      // run update validations
      return updateValidations({updateId: mergeResult.id, updateRecord: new MarcRecord(mergeResult.record, {subfieldValues: false}), updateOperation: 'updateAfterMerge', mergeValidationResult, headers, recordMetadata});

    // throw new ValidationError(HttpStatus.CONFLICT, {message: 'Duplicates in database, merge flag true, cannot merge yet', ids: matchResults.map(({candidate: {id}}) => id)});
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
}
