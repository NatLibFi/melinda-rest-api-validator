import HttpStatus from 'http-status';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ValidationError, toAlephId} from '@natlibfi/melinda-commons';
import {validations, conversions, format, OPERATIONS, logError} from '@natlibfi/melinda-rest-api-commons';
import createSruClient from '@natlibfi/sru-client';
import validateOwnChanges from './own-authorization';
import {updateField001ToParamId, getRecordMetadata, getIdFromRecord} from '../../utils';
import {validateExistingRecord} from './validate-existing-record';
import {inspect} from 'util';
import {MarcRecord} from '@natlibfi/marc-record';
import {matchValidationForMatchResults} from './match-validation';
import merger from './merge';
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
    const {format, operationSettings, recordMetadata, operation, id} = headers;
    logger.debug(`process headers ${JSON.stringify(headers)}`);

    // create recordObject
    logger.debug(`Data is in format: ${format}, prio: ${operationSettings.prio}, noStream: ${operationSettings.noStream}`);
    const record = operationSettings.prio || format || operationSettings.noStream ? await unserializeAndFormatRecord(data, format, formatOptions) : new MarcRecord(formatRecord(data, formatOptions));

    // Add to recordMetadata data from the record
    // For CREATEs get all possible sourceIds, for UPDATEs get just the 'best' set from 003+001/001, f035az:s, SID:s
    const getAllSourceIds = operation === OPERATIONS.CREATE;
    logger.debug(`Original recordMetadata: ${JSON.stringify(recordMetadata)}`);
    const combinedRecordMetadata = getRecordMetadata({record, recordMetadata, getAllSourceIds});
    logger.debug(`Combined recordMetadata: ${JSON.stringify(combinedRecordMetadata)}`);

    // Create here also headers.id for batchBulk -records
    // For CREATE: blobSequence, for UPDATE: id from record (001)
    logger.debug(`id check`);

    // This should error if we do not have id from headers or record for UPDATEs
    const idFromOperation = operation === OPERATIONS.CREATE ? await toAlephId(combinedRecordMetadata.blobSequence.toString()) : await getIdFromRecord(record);
    logger.debug(`Original id: ${id}, newly created id: ${idFromOperation}`);

    if (operation === OPERATIONS.UPDATE && !id && !idFromOperation) {
      throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, {message: `There is no id for updating the record`, recordMetadata: combinedRecordMetadata});
    }

    const newHeaders = {
      ...headers,
      id: id || idFromOperation,
      recordMetadata: combinedRecordMetadata
    };

    logger.debug(`New headers: ${JSON.stringify(newHeaders)}`);

    return processNormal({record, headers: newHeaders});
  }

  // eslint-disable-next-line max-statements
  async function processNormal({record, headers}) {
    logger.silly(`validator/index/process: Running validations for (${headers.recordMetadata.sourceId})`);
    logger.debug(`validator/index/process: ${JSON.stringify(headers)}`);
    try {
      const {result, operationAfterValidation, idAfterValidation, mergeValidationResult, recordMetadata} = await executeValidations({record, headers});

      // If the incoming record was merged in the validationProcess, update operation to 'UPDATE'
      const newOperation = operationAfterValidation === 'updateAfterMerge' ? 'UPDATE' : operationAfterValidation;
      const newId = idAfterValidation;

      const mergeNote = mergeValidationResult && mergeValidationResult.merged
        ? `Merged to ${newId} preferring ${mergeValidationResult.preference === 'A' ? 'incoming record.' : 'database record.'}`
        : undefined;

      const updatedHeaders = mergeValidationResult && mergeValidationResult.merged
        ? {
          operation: newOperation,
          id: newId,
          notes: headers.notes ? headers.notes.concat(mergeNote) : [mergeNote]
        }
        : {
          operation: newOperation,
          id: newId
        };

      const newHeaders = {...headers, ...updatedHeaders};

      logger.debug(`validator/index/process: Validation result: ${inspect(result, {colors: true, maxArrayLength: 3, depth: 4})}`);
      logger.debug(`validator/index/process: operationAfterValidation: ${operationAfterValidation}, newOperation: ${newOperation}, original operation: ${headers.operation}`);

      // throw ValidationError for failed validationService
      if (result.failed) { // eslint-disable-line functional/no-conditional-statement
        logger.debug('Validation failed');
        throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, {message: result.messages, recordMetadata});
      }

      return {headers: newHeaders, data: result.record.toObject()};

    } catch (err) {
      logger.debug(`processNormal: validation errored: ${JSON.stringify(err)}`);
      if (err instanceof ValidationError) {
        logger.debug(`Error is a validationError.`);
        const {status, payload} = err;
        const newPayload = {
          recordMetadata: headers.recordMetadata,
          ...payload
        };
        logger.debug(`Payload from error: ${JSON.stringify(payload)}`);
        logger.debug(`New payload: ${JSON.stringify(newPayload)}`);
        throw new ValidationError(status, newPayload);
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
    logger.debug('Validating the record');

    if (headers.operation === OPERATIONS.UPDATE) {
      return updateValidations({updateId: headers.id, updateRecord: record, updateOperation: headers.operation, headers});
    }

    return createValidations({record, headers});
  }

  // eslint-disable-next-line max-statements
  async function updateValidations({updateId, updateRecord, updateOperation, mergeValidationResult = undefined, headers}) {
    logger.verbose(`Validations for UPDATE operation (${updateOperation}) (${updateId}) for ${headers.correlationId}`);
    logger.debug(`updateValidation, headers (${JSON.stringify(headers)})`);
    logger.debug(`MergeValidationResult: ${mergeValidationResult}`);
    logger.debug(`UpdateId: ${JSON.stringify(updateId)}`);

    const {recordMetadata, operationSettings, cataloger} = headers;

    if (updateId) {
      // This takes care of the cases, where a CREATE record was merged -> record gets its 001 so it can be updated in Melinda
      const updatedRecord = updateField001ToParamId(`${updateId}`, updateRecord);
      logger.silly(`Updated record:\n${JSON.stringify(updatedRecord)}`);

      logger.verbose(`Reading record ${updateId} from SRU for ${headers.correlationId}`);
      const existingRecord = await getRecord(updateId);
      logger.silly(`Record from SRU: ${JSON.stringify(existingRecord)}`);

      if (!existingRecord) {
        logger.debug(`Record ${updateId} was not found from SRU.`);
        throw new ValidationError(HttpStatus.NOT_FOUND, {message: `Cannot find record ${updateId} to update`, recordMetadata});
      }

      // aleph-record-load-api cannot currently update a record if the existing record is deleted
      logger.verbose('Checking whether the existing record is deleted');
      validateExistingRecord(existingRecord, recordMetadata);

      // Merge for updates (do not run if record is already merged CREATE)
      logger.debug(`Check whether merge is needed for update`);
      logger.debug(`headers: ${JSON.stringify(headers)}, updateOperation: ${updateOperation}`);
      const updateMergeNeeded = operationSettings.merge && updateOperation !== 'updateAfterMerge';
      const {mergedRecord: updatedRecordAfterMerge, mergeValidationResult: mergeValidationResultAfterMerge} = updateMergeNeeded ? await mergeRecordForUpdates({record: updatedRecord, existingRecord, id: updateId, headers}) : {mergedRecord: updatedRecord, mergeValidationResult};

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
      if (cataloger.authorization) {
        logger.verbose('Checking LOW-tag authorization');
        validateOwnChanges({ownTags: cataloger.authorization, incomingRecord: updatedRecordAfterMerge, existingRecord, recordMetadata});
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

      // validationResults: {record, failed: true/false, messages: []}
      const validationResults = await validationService(updatedRecordAfterMerge);

      return {result: validationResults, operationAfterValidation: updateOperation, idAfterValidation: updateId, mergeValidationResult: mergeValidationResultAfterMerge, recordMetadata};
    }

    logger.debug('No id in headers / merge results');
    throw new ValidationError(HttpStatus.BAD_REQUEST, {message: 'Update id missing!', recordMetadata});
  }

  // eslint-disable-next-line max-statements
  async function createValidations({record, headers}) {
    const {recordMetadata, cataloger, operationSettings, operation, id} = headers;

    logger.verbose(`Validations for CREATE operation. Unique: ${operationSettings.unique}, merge: ${operationSettings.merge}`);

    // bulks do not have cataloger.authorization
    // eslint-disable-next-line functional/no-conditional-statement
    if (cataloger.authorization) {
      logger.verbose('Checking LOW-tag authorization');
      validateOwnChanges({ownTags: cataloger.authorization, incomingRecord: record, recordMetadata});
      // eslint-disable-next-line functional/no-conditional-statement
    } else {
      logger.verbose(`No cataloger.authorization available for checking LOW-tags`);
    }

    if (operationSettings.unique || operationSettings.merge) {
      logger.verbose('Attempting to find matching records in the SRU');

      logger.debug(`There are ${matchers.length} matchers with matchOptions: ${JSON.stringify(matchOptionsList)}`);
      // This should use different matchOptions for merge and non-merge cases
      // Note: incoming record is formatted ($w(FIN01)), existing records from SRU are not ($w(FI-MELINDA))
      // stopWhenFound stops iterating matchers when a match is found
      const {matches} = await matcherService.iterateMatchers({matchers, matchOptionsList, record, stopWhenFound: false});
      logger.debug(JSON.stringify(matches.map(({candidate: {id}, probability}) => ({id, probability}))));

      // this could update headers.notes with a matchResult

      // eslint-disable-next-line functional/no-conditional-statement
      if (matches.length > 0 && !operationSettings.merge) {
        throw new ValidationError(HttpStatus.CONFLICT, {message: 'Duplicates in database', ids: matches.map(({candidate: {id}}) => id), recordMetadata});
      }

      // eslint-disable-next-line functional/no-conditional-statement
      if (matches.length > 0 && operationSettings.merge) {
        logger.debug(`Found matches (${matches.length}) for merging.`);
        return validateAndMergeMatchResults({record, matchResults: matches, formatOptions, headers});
      }

      logger.verbose('No matching records');

      // Note validationService = validation.js from melinda-rest-api-commons
      // which uses marc-record-validate
      // currently checks only that possible f003 has value FI-MELINDA
      // for some reason this does not work for noop CREATEs

      const validationResults = await validationService(record);
      return {result: validationResults, operationAfterValidation: operation, idAfterValidation: id, recordMetadata};
    }

    logger.debug('No unique/merge');
    const validationResults = await validationService(record);
    return {result: validationResults, operationAfterValidation: operation, idAfterValidation: id, recordMetadata};
  }

  async function validateAndMergeMatchResults({record, matchResults, formatOptions, headers}) {
    const {recordMetadata} = headers;
    try {
      logger.debug(`We have matchResults (${matchResults.length}) here: ${JSON.stringify(matchResults.map(({candidate: {id}, probability}) => ({id, probability})))}`);
      logger.silly(`matchResults: ${inspect(matchResults, {colors: true, maxArrayLength: 3, depth: 2})}`);

      // run matchValidation for record & matchResults
      // -> choose the best possible match, and choose which record should be preferred in merge
      // -> error if none of the matches are valid

      // does matchValidationResult need to include record?
      // matchValidationResult: {record, result: {candidate: {id, record}, probability, matchSequence, action, preference: {value, name}}} - possible note, matchValidationReport later

      const matchValidationResult = await matchValidationForMatchResults(record, matchResults, formatOptions, recordMetadata);
      logger.silly(`MatchValidationResult: ${inspect(matchValidationResult, {colors: true, maxArrayLength: 3, depth: 3})}}`);
      const firstResult = matchValidationResult.result;
      logger.silly(`Result: ${inspect(firstResult, {colors: true, maxArrayLength: 3, depth: 2})}}`);

      // Check error cases
      if (!matchValidationResult.result) {
        throw new ValidationError(HttpStatus.CONFLICT, {message: `MatchValidation for all matches failed.`, recordMetadata});
      }
      if (firstResult.action === false) {
        throw new ValidationError(HttpStatus.CONFLICT, {message: `MatchValidation with ${firstResult.candidate.id} failed. ${firstResult.message}`, ids: [firstResult.candidate.id], recordMetadata});
      }

      // this could update headers.notes with a matchValidation result

      logger.debug(`Action from matchValidation: ${firstResult.action}`);

      // run merge for record with the best valid match
      return mergeValidatedMatchResults({record, result: firstResult, headers});
    } catch (err) {
      logger.debug(`MatchValidation errored`);
      logger.error(err);
      throw err;
    }
  }

  async function mergeValidatedMatchResults({record, result, headers}) {

    const {recordMetadata} = headers;

    try {
      //logger.silly(inspect(record));
      //logger.silly(inspect(result));

      //result: {candidate: {id, record}, probability, matchSequence, action, preference: {value, name}}}
      const {preference, candidate} = result;

      // A: incoming record, B: database record
      // base: preferred record, souce: non-preferred record
      logger.verbose(`Preference for merge: Using '${preference.value}' as preferred/base record - '${preference.name}'. (A: incoming record, B: database record)`);

      // Prefer database record (B) unless we got an explicit preference for incoming record (A) from matchValidation.result
      const mergeRequest = preference.value && preference.value === 'A' ? {
        source: candidate.record,
        base: record
      } : {
        source: record,
        base: candidate.record
      };

      //logger.debug(inspect(mergeRequest));

      // mergeResult.record: merged record that can be used to update the database record
      // mergeResult.report: report from merge -> to be saved to mongo etc
      // mergeResult.status: true

      const mergeResult = await merger(mergeRequest);
      logger.debug(`Got mergeResult: ${JSON.stringify(mergeResult)}`);
      const mergeValidationResult = {merged: mergeResult.status, mergedId: candidate.id, preference: preference.value};
      // run update validations

      return updateValidations({updateId: candidate.id, updateRecord: new MarcRecord(mergeResult.record, {subfieldValues: false}), updateOperation: 'updateAfterMerge', mergeValidationResult, headers});
    } catch (err) {
      logger.debug(`mergeMatchResults errored: ${err}`);

      // if error was about merging try the next best valid match - we got just one match from matchValidation - in which cases merge would fail these?
      // -> if all matches error merging semantically?

      logError(err);
      const errorMessage = err.message;
      throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, {message: `Merge errored: ${errorMessage}`, recordMetadata});
    }
  }

  async function mergeRecordForUpdates({record, existingRecord, id, headers}) {
    logger.debug(`Merging record ${id} to existing record ${id}`);
    const {recordMetadata} = headers;

    // Should we matchValidate this to get preference?

    try {
      const mergeRequest = {
        source: record,
        base: existingRecord
      };

      // mergeResult.record: merged record that can be used to update the database record
      // mergeResult.status: true

      const mergeResult = await merger(mergeRequest);
      logger.debug(JSON.stringify(mergeResult));

      const mergeValidationResult = {merged: mergeResult.status, mergedId: mergeResult.id, preference: 'B'};
      return {mergedRecord: new MarcRecord(mergeResult.record, {subfieldValues: false}), mergeValidationResult};
    } catch (err) {
      logger.error(`mergeRecordForUpdates errored: ${err}`);
      logError(err);
      const errorMessage = err;
      throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, {message: `Merge errored: ${errorMessage}`, recordMetadata});
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
