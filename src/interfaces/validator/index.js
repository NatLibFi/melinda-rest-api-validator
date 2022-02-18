import deepEqual from 'deep-eql';
import HttpStatus from 'http-status';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ValidationError} from '@natlibfi/melinda-commons';
import {validations, conversions, format, OPERATIONS, logError} from '@natlibfi/melinda-rest-api-commons';
import createSruClient from '@natlibfi/sru-client';
import validateOwnChanges from './own-authorization';
import {updateField001ToParamId, getIncomingIdFromRecord} from '../../utils';
import {validateExistingRecord} from './validate-existing-record';
import {inspect} from 'util';
import {MarcRecord} from '@natlibfi/marc-record';
import {matchValidation} from './match-validation-mock';
import merger from './merge-mock';
import * as matcherService from './match';
import createMatchInterface from '@natlibfi/melinda-record-matching';

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
    logger.debug(`process headers ${JSON.stringify(headers)}`);

    const {
      operation,
      format,
      cataloger
    } = headers;

    const id = headers.id || undefined;
    const unique = headers.unique || undefined;
    const merge = headers.merge || undefined;
    const prio = headers.prio || undefined;
    const incoming = headers.incoming || undefined;

    // for prioTasks unserialize and format, for bulk tasks just format - bulk option needs testing
    const record = prio ? await unserializeAndFormatRecord(data, format, formatOptions) : new MarcRecord(formatRecord(data, formatOptions));

    const incomingId = incoming ? incoming.incomingId : getIncomingIdFromRecord(record);
    const incomingSeq = incoming ? incoming.incomingSeq : '1';

    logger.debug(`Incoming id: ${incomingId}, incoming seq: ${incomingSeq}`);
    logger.silly(record);

    // All other validations result in errors when they fail, only validationService returns result.failed
    // for bulk we should catch these errors, because we might want to handle non-erroring records
    // validation result from validationService: {record, failed, messages: []}
    // should we get {record, failed, messages: [], error} -response also from other validations?

    //if (noop) {
    //  return processNoop();
    //}

    return processNormal();

    /*
    async function processNoop() {

      // How should merge-noops be handled?

      logger.debug(`validator/index/process: Add status to noop`);
      const result = {
        status: operation === 'CREATE' ? 'CREATED' : 'UPDATED',
        ...await executeValidations()
      };
      logger.debug(`validator/index/process: Validation result for noop: ${inspect(result, {colors: true, maxArrayLength: 3, depth: 1})}`);
      logger.debug(`return result for noop`);
      return result;
    }
    */

    async function processNormal() {
      logger.silly(`validator/index/process: Running validations for normal (${incomingId})`);

      try {
        const {result, operationAfterValidation, mergeValidationResult} = await executeValidations();
        const newOperation = operationAfterValidation === 'merge' ? 'UPDATE' : operationAfterValidation;

        logger.debug(`validator/index/process: Validation result for non-noop: ${inspect(result, {colors: true, maxArrayLength: 3, depth: 1})}`);
        logger.debug(`validator/index/process: operationAfterValidation: ${operationAfterValidation}, newOperation: ${newOperation}, original operation: ${operation}`);
        logger.debug(`validator/index/process: mergeValidationResult: ${mergeValidationResult}`);


        // throw ValidationError for failed validationService
        if (result.failed) { // eslint-disable-line functional/no-conditional-statement
          logger.debug('Validation failed');
          throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, result.messages);
        }

        return {headers: {operation: newOperation, cataloger: cataloger.id, incoming: {incomingId, incomingSeq: '1'}}, data: result.record.toObject(), mergeValidationResult};

      } catch (error) {
        logger.debug(`validation errored`);
        // this could add errors to logMongo
        throw error;
      }
    }

    async function unserializeAndFormatRecord(data, format, formatOptions) {
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
        throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, `Parsing input data failed. ${cleanErrorMessage}`);
      }
    }

    function executeValidations() {
      logger.verbose('Validating the record');

      if (operation === OPERATIONS.UPDATE) {
        return updateValidations({updateId: id, updateRecord: record, updateOperation: operation});
      }

      return createValidations();
    }

    // eslint-disable-next-line max-statements
    async function updateValidations({updateId = id, updateRecord = record, updateOperation = operation, mergeValidationResult = undefined}) {
      logger.verbose(`Validations for UPDATE operation (${updateOperation})`);
      logger.verbose(`MergeValidationResult: ${mergeValidationResult}`);
      logger.debug(JSON.stringify(updateId));
      //logger.debug(JSON.stringify(updateRecord));

      if (updateId) {
        const updatedRecord = updateField001ToParamId(`${updateId}`, updateRecord);
        logger.silly(`Updated record:\n${JSON.stringify(updatedRecord)}`);

        logger.verbose(`Reading record ${updateId} from SRU`);
        const existingRecord = await getRecord(updateId);
        logger.silly(`Record from SRU: ${JSON.stringify(existingRecord)}`);

        if (!existingRecord) {
          logger.debug(`Record ${updateId} was not found from SRU.`);
          throw new ValidationError(HttpStatus.NOT_FOUND, `Cannot find record ${updateId} to update`);
        }

        const formattedExistingRecord = formatRecord(existingRecord, formatOptions);
        logger.silly(`Formatted record from SRU: ${JSON.stringify(formattedExistingRecord)}`);

        // aleph-record-load-api cannot currently update a record if the existing record is deleted
        logger.verbose('Checking whether the existing record is deleted');
        validateExistingRecord(existingRecord);

        // Merge for updates (do not run if record is already merged CREATE)
        // Note: incoming record is formatted ($w(FIN01)), existing record is t ($w(FI-MELINDA))
        const updateMergeNeeded = merge && updateOperation !== 'merge';
        const {mergedRecord: updatedRecordAfterMerge, mergeValidationResult: mergeValidationResultAfterMerge} = updateMergeNeeded ? await mergeRecordForUpdates({record: updatedRecord, existingRecord, id: updateId}) : {mergedRecord: updatedRecord, mergeValidationResult};
        logger.debug(`We needed merge for UPDATE: ${updateMergeNeeded}`);
        logger.debug(`Original incoming record: ${updatedRecord}`);
        logger.debug(`Incoming record after merge: ${updatedRecordAfterMerge}`);

        logger.verbose('Checking LOW-tag authorization');
        validateOwnChanges(cataloger.authorization, updatedRecordAfterMerge, existingRecord);

        logger.verbose('Checking CAT field history');
        validateRecordState(updatedRecordAfterMerge, existingRecord);

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
      throw new ValidationError(HttpStatus.BAD_REQUEST, 'Update id missing!');
    }

    // eslint-disable-next-line max-statements
    async function createValidations() {
      logger.verbose(`Validations for CREATE operation. Unique: ${unique}, merge: ${merge}`);

      // Do we need this?
      const updatedRecord = updateField001ToParamId('1', record);
      logger.silly(`Updated record:\n${JSON.stringify(updatedRecord)}`);

      logger.verbose('Checking LOW-tag authorization');
      await validateOwnChanges(cataloger.authorization, updatedRecord);

      if (unique) {
        logger.verbose('Attempting to find matching records in the SRU');

        logger.debug(`There are ${matchers.length} matchers with matchOptions: ${JSON.stringify(matchOptionsList)}`);
        // This should use different matchOptions for merge and non-merge cases
        // Note: incoming record is formatted ($w(FIN01)), existing records from SRU are not ($w(FI-MELINDA))
        const matchResults = await matcherService.iterateMatchersUntilMatchIsFound({matchers, matchOptionsList, updatedRecord});
        logger.verbose(JSON.stringify(matchResults));
        // eslint-disable-next-line functional/no-conditional-statement
        if (matchResults.length > 0 && !merge) {
          throw new ValidationError(HttpStatus.CONFLICT, {message: 'Duplicates in database', ids: matchResults.map(({candidate: {id}}) => id)});
        }

        // eslint-disable-next-line functional/no-conditional-statement
        if (matchResults.length > 0 && merge) {
          logger.debug(`Found matches (${matchResults.length} for merging)`);
          return validateAndMergeMatchResults(updatedRecord, matchResults);
        }

        logger.verbose('No matching records');

        // Note validationService = validation.js from melinda-rest-api-commons
        // which uses marc-record-validate
        // currently checks only that possible f003 has value FI-MELINDA
        // for some reason this does not work for noop CREATEs

        const validationResults = await validationService(updatedRecord);
        return {result: validationResults, operationAfterValidation: operation};
      }

      logger.debug('No unique');
      const validationResults = await validationService(updatedRecord);
      return {result: validationResults, operationAfterValidation: operation};
    }

    async function validateAndMergeMatchResults(record, matchResults) {
      try {
        logger.debug(`We have matchResults here: ${JSON.stringify(matchResults)}`);

        // Note: incoming record is formatted ($w(FIN01)), existing record is not ($w(FI-MELINDA))

        // run matchValidation for record & matchResults
        // -> choose the best possible match
        // -> if none of the matches are valid, what to do?

        // Is the match mergeable?
        // Which of the records should be preferred

        // currently handles just one record, should handle several matches

        const matchValidationResult = await matchValidation(record, matchResults[0].candidate.record);
        logger.debug(`MatchValidationResult: ${JSON.stringify(matchValidationResult)}`);
        logger.debug(matchValidationResult.action);

        if (matchValidationResult.action === false) {
          throw new ValidationError(HttpStatus.CONFLICT, `MatchValidation failed. ${matchValidationResult.message}`);
        }
        logger.debug(matchValidationResult.action);
        logger.debug(`We did not catch action`);


        // Note this does not do anything about matchValidationResults yet
        return mergeValidatedMatchResults(record, matchResults);
      } catch (err) {
        logger.debug(`MatchValidation errored`);
        logger.error(err);
        throw err;
      }
    }

    async function mergeValidatedMatchResults(record, matchResults) {

      // run merge based on matchValidation results

      // base = preferred record, in this case the matching datastore record
      // source = non-preferred record, in this case the incoming record

      const mergeRequest = {
        source: record,
        sourceId: undefined,
        base: matchResults[0].candidate.record,
        baseId: matchResults[0].candidate.id
      };

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
        throw err;
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

    function handleMergeResult(mergeResult) {

      logger.debug(`Got mergeResult: ${JSON.stringify(mergeResult)}`);
      const mergeValidationResult = {merged: mergeResult.status, mergedId: mergeResult.id};

      // run update validations
      return updateValidations({updateId: mergeResult.id, updateRecord: new MarcRecord(mergeResult.record, {subfieldValues: false}), updateOperation: 'merge', mergeValidationResult});

    // throw new ValidationError(HttpStatus.CONFLICT, {message: 'Duplicates in database, merge flag true, cannot merge yet', ids: matchResults.map(({candidate: {id}}) => id)});
    }

    // Checks that the modification history is identical
    function validateRecordState(incomingRecord, existingRecord) {
      const logger = createLogger();
      // why the incomingRecord would be an array? is this also a relic from merge-UI?
      const incomingModificationHistory = Array.isArray(incomingRecord) ? incomingRecord : incomingRecord.get(/^CAT$/u);
      const existingModificationHistory = existingRecord.get(/^CAT$/u) || [];

      // the next is not needed? this is not used with Merge-UI?
      // Merge makes uuid variables to all fields and this removes those
      const incomingModificationHistoryNoUuids = incomingModificationHistory.map(field => ({tag: field.tag, ind1: field.ind1, ind2: field.ind2, subfields: field.subfields}));

      logger.silly(`Incoming CATS:\n${JSON.stringify(incomingModificationHistoryNoUuids)}`);
      logger.silly(`Existing CATS:\n${JSON.stringify(existingModificationHistory)}`);

      if (deepEqual(incomingModificationHistoryNoUuids, existingModificationHistory) === false) { // eslint-disable-line functional/no-conditional-statement
        throw new ValidationError(HttpStatus.CONFLICT, {message: 'Modification history mismatch (CAT)'});
      }
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

