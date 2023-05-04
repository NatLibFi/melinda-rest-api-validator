import HttpStatus from 'http-status';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ValidationError, toAlephId} from '@natlibfi/melinda-commons';
import {validations, conversions, fixes, OPERATIONS, logError} from '@natlibfi/melinda-rest-api-commons';
import createSruClient from '@natlibfi/sru-client';
import validateOwnChanges from './own-authorization';
import {updateField001ToParamId, getRecordMetadata, getIdFromRecord, isValidAlephId} from '../../utils';
import {validateExistingRecord} from './validate-existing-record';
import {inspect} from 'util';
import {MarcRecord} from '@natlibfi/marc-record';
import {matchValidationForMatchResults} from './match-validation';
import merger from './merge';
import * as matcherService from './match';
import createMatchInterface from '@natlibfi/melinda-record-matching';
import {validateRecordState} from './validate-record-state';
import {validateChanges} from './validate-changes';
import {validateUpdate} from './validate-update';
//import {detailedDiff} from 'deep-object-diff';
import {LOG_ITEM_TYPE} from '@natlibfi/melinda-rest-api-commons/dist/constants';

//import createDebugLogger from 'debug';
//const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator');
//const debugData = debug.extend('data');

export default async function ({preValidationFixOptions, postMergeFixOptions, preImportFixOptions, sruUrl, matchOptionsList, mongoLogOperator, recordType, stopWhenFound, acceptZeroWithMaxCandidates, logNoMatches}) {
  const logger = createLogger();
  logger.debug(`preValidationFixOptions: ${JSON.stringify(preValidationFixOptions)}`);
  logger.debug(`postMergeFixOptions: ${JSON.stringify(postMergeFixOptions)}`);
  logger.debug(`preImportFixOptions: ${JSON.stringify(preImportFixOptions)}`);

  // fixRecord: record fixes from melinda-rest-api-commons
  // for pre-, mid- and postValidation fixing the record
  // preValidationFix:
  //    - add missing sids
  // postMergeFix:
  //    - handle tempURNs
  //    - this should handle extra f884s too
  // preImportFix:
  //    - format $w and $0 codes to alephInternal Format
  // formerly known as formatRecord
  const {fixRecord} = fixes;

  // validationService: marc-record-validate validations from melinda-rest-api-commons
  const validationService = await validations();
  const ConversionService = conversions();
  // should we have here matcherService? commons mongo/amqp
  const matchers = matchOptionsList.map(matchOptions => createMatchInterface(matchOptions));
  logger.debug(`We created ${matchers.length} matchers`);
  const sruClient = createSruClient({url: sruUrl, recordSchema: 'marcxml', retrieveAll: false, maximumRecordsPerRequest: 1});
  //logger.debug(`Creating mongoLogOperator in ${mongoUri}`);
  //const mongoLogOperator = await mongoLogFactory(mongoUri);

  return {process};

  // eslint-disable-next-line max-statements
  async function process(headers, data) {
    const {format, operationSettings, recordMetadata, operation, id} = headers;
    logger.debug(`process headers ${JSON.stringify(headers)}`);

    if (recordType !== 'bib' && (operationSettings.merge || operationSettings.unique)) {
      throw new ValidationError(HttpStatus.BAD_REQUEST, {message: `merge=1 and unique=1 are not yet usable with non-bib records. <${recordType}>`, recordMetadata});
    }

    // create recordObject
    logger.debug(`Data is in format: ${format}, prio: ${operationSettings.prio}, noStream: ${operationSettings.noStream}`);
    const record = operationSettings.prio || format || operationSettings.noStream ? await unserializeAndFormatRecord(data, format, preValidationFixOptions) : new MarcRecord(fixRecord(data, preValidationFixOptions), {subfieldValues: false});

    // Add to recordMetadata data from the record
    // For CREATEs get all possible sourceIds, for UPDATEs get just the 'best' set from 003+001/001, f035az:s, SID:s
    const getAllSourceIds = operation === OPERATIONS.CREATE;
    logger.debug(`Original recordMetadata: ${JSON.stringify(recordMetadata)}`);
    const combinedRecordMetadata = getRecordMetadata({record, recordMetadata, getAllSourceIds});
    logger.debug(`Combined recordMetadata: ${JSON.stringify(combinedRecordMetadata)}`);

    // Create here also headers.id for batchBulk -records
    // For CREATE: blobSequence, for UPDATE: id from record (001)
    logger.debug(`id check for ${operation}`);

    const idFromOperation = operation === OPERATIONS.CREATE ? await toAlephId(combinedRecordMetadata.blobSequence.toString()) : await getIdFromRecord(record);
    logger.debug(`Original id: ${id}, newly created id: ${idFromOperation}`);
    const newId = id || idFromOperation;

    // We do not update the CREATE record itself here, because incoming 001 might be useful for matching etc.
    if (operation === OPERATIONS.UPDATE && (!newId || !isValidAlephId(newId))) {
      throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, {message: `There is no valid id for updating the record. <${newId}>`, recordMetadata: combinedRecordMetadata});
    }

    const newHeaders = {
      ...headers,
      id: newId,
      recordMetadata: combinedRecordMetadata
    };

    logger.debug(`New headers: ${JSON.stringify(newHeaders)}`);

    // Currently do not allow total skipping of validations for batchBulk and prio (streamBulk-records skip validation as default)
    const validateRecords = operationSettings.merge || operationSettings.unique || operationSettings.validate || operationSettings.noStream || operationSettings.prio;
    logger.debug(`We need to validate records: ${validateRecords}`);
    logger.debug(`-- merge: ${operationSettings.merge} || unique: ${operationSettings.unique} || validate: ${operationSettings.validate} || noStream: ${operationSettings.noStream} || prio: ${operationSettings.prio}`);

    if (validateRecords) {
      return processNormal({record, headers: newHeaders});
    }

    logger.verbose(`Skipped record validate/unique/merge due to operationSettings`);
    // We propably should update 001 in record to id here?
    const validatedRecord = checkAndUpdateId({record, headers});
    return {headers, data: validatedRecord.toObject()};
  }

  // eslint-disable-next-line max-statements
  async function processNormal({record, headers}) {
    logger.silly(`validator/index/process: Running validations for (${headers.recordMetadata.sourceId})`);
    logger.debug(`validator/index/process: ${JSON.stringify(headers)}`);
    try {
      const {result, recordMetadata, headers: resultHeaders} = await executeValidations({record, headers});

      // We got headers back
      logger.debug(`validator/index/process: Headers after validation: ${JSON.stringify(resultHeaders)}`);
      logger.silly(`validator/index/process: Validation result: ${inspect(result, {colors: true, maxArrayLength: 3, depth: 4})}`);

      // throw ValidationError for failed validationService
      if (result.failed) {
        logger.debug('Validation failed');
        throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, {message: result.messages, recordMetadata});
      }

      // We check/update 001 in record to id in headers here
      const validatedRecord = await checkAndUpdateId({record: result.record, headers: resultHeaders});

      // preImportFix - format $0 and $w to alephInternal format
      const fixedRecordObject = await fixRecord(validatedRecord, preImportFixOptions);

      return {headers: resultHeaders, data: fixedRecordObject};

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

  // Should this handle f003 too? If it should, we should get valid f003 contents from a variable
  function checkAndUpdateId({record, headers}) {
    logger.debug(`--- Check and update id ---`);
    const recordF001 = getIdFromRecord(record);
    const sequence = headers.recordMetadata.blobSequence;
    const {noStream, prio} = headers.operationSettings;
    logger.debug(`Operation: ${headers.operation}, Id from headers: <${headers.id}>, Id from record: <${recordF001}>, blobSequence: <${sequence}>, noStream: ${noStream}, prio: ${prio}`);
    if (!recordF001 || headers.id !== recordF001) {
      logger.verbose(`We have a id in headers ${headers.id}, but the f001 in record ${recordF001} is not matching. Updating the record.`);
      const updatedRecord = updateField001ToParamId(`${headers.id}`, record);
      return updatedRecord;
    }
    return record;
  }

  async function unserializeAndFormatRecord(data, format, prevalidationFixOptions, recordMetadata) {
    try {
      logger.silly(`Data: ${JSON.stringify(data)}`);
      logger.silly(`Format: ${format}`);
      const unzerialized = await ConversionService.unserialize(data, format);
      logger.silly(`Unserialized data: ${JSON.stringify(unzerialized)}`);
      // Format record - currently for bibs edit $0 and $w ISILs to Aleph internar library codes
      const recordObject = await fixRecord(unzerialized, preValidationFixOptions);
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
    logger.debug(`MergeValidationResult: ${JSON.stringify(mergeValidationResult)}`);
    logger.debug(`UpdateId: ${JSON.stringify(updateId)}`);

    const {recordMetadata, operationSettings, cataloger} = headers;

    // Currently also melinda-api-http forces all validations (validate=true) for prio and batchBulk
    const runValidations = operationSettings.validate || true;

    if (updateId) {
      // -> updating f001 is done later in processNormal, so it gets done to other CREATE operation too

      logger.verbose(`Reading record ${updateId} from SRU for ${headers.correlationId}`);
      const existingRecord = await getRecord(updateId);
      // let's not fixFormat existing record, we have the incoming record in the externalFormat still
      logger.silly(`Record from SRU: ${JSON.stringify(existingRecord)}`);

      if (!existingRecord) {
        logger.debug(`Record ${updateId} was not found from SRU.`);
        throw new ValidationError(HttpStatus.NOT_FOUND, {message: `Cannot find record ${updateId} to update`, recordMetadata});
      }

      // aleph-record-load-api cannot currently update a record if the existing record is deleted
      logger.verbose('Checking whether the existing record is deleted');
      validateExistingRecord(existingRecord, recordMetadata, runValidations);

      // Merge for updates (do not run if record is already merged CREATE)
      logger.debug(`Check whether merge is needed for update`);
      logger.debug(`headers: ${JSON.stringify(headers)}, updateOperation: ${updateOperation}`);
      const updateMergeNeeded = operationSettings.merge && updateOperation !== 'updateAfterMerge';
      const {mergedRecord: updatedRecordAfterMerge, headers: newHeaders} = updateMergeNeeded ? await mergeRecordForUpdates({record: updateRecord, existingRecord, id: updateId, headers}) : {mergedRecord: updateRecord, headers};

      runValidateOwnChanges({cataloger, incomingRecord: updatedRecordAfterMerge, existingRecord, operation: headers.operation, recordMetadata, runValidations});

      logger.verbose('Checking CAT field history');
      validateRecordState({incomingRecord: updatedRecordAfterMerge, existingRecord, existingId: updateId, recordMetadata, validate: runValidations});

      // Note validationService = validation.js from melinda-rest-api-commons
      // which uses marc-record-validate
      // currently checks only that possible f003 has value FI-MELINDA
      // for some reason this does not work for noop CREATEs

      //const mergeValidationResult = updateOperation === 'merge' ? {merged: true, mergedId: updateId} : {merged: false};
      logger.debug(`mergeValidationResult: ${JSON.stringify(mergeValidationResult)}`);

      // validationResults: {record, failed: true/false, messages: []}
      const validationResults = runValidations ? await validationService(updatedRecordAfterMerge) : {record: updatedRecordAfterMerge, failed: false};

      // Validator checks here (if needed), if the update would actually change the database record
      logger.verbose(`Checking if the update actually changes the existing record. (skipNoChangeUpdates: ${operationSettings.skipNoChangeUpdates})`);

      const {changeValidationResult} = validateChanges({incomingRecord: updatedRecordAfterMerge, existingRecord, validate: operationSettings.skipNoChangeUpdates && runValidations});

      logger.debug(changeValidationResult === 'skipped' ? `-- ChangeValidation not needed` : `-- ChangeValidationResult: ${JSON.stringify(changeValidationResult)}`);

      if (changeValidationResult === false) {
        const newNote = `No changes detected while trying to update existing record ${updateId}, update skipped.`;
        const updatedHeaders = {
          operation: 'SKIPPED',
          notes: newHeaders.notes ? newHeaders.notes.concat(`${newNote}`) : [newNote]
        };
        const finalHeaders = {...headers, ...updatedHeaders};

        return {result: validationResults, recordMetadata, headers: finalHeaders};
      }

      return {result: validationResults, recordMetadata, headers: newHeaders};
    }

    logger.debug('No id in headers / merge results');
    throw new ValidationError(HttpStatus.BAD_REQUEST, {message: 'Update id missing!', recordMetadata});
  }

  // eslint-disable-next-line max-statements
  async function createValidations({record, headers}) {
    const {recordMetadata, cataloger, operationSettings} = headers;
    // Currently force all validations for prio and batchBulk
    const runValidations = operationSettings.validate || true;

    logger.verbose(`Validations for CREATE operation. Unique: ${operationSettings.unique}, merge: ${operationSettings.merge}`);

    runValidateOwnChanges({cataloger, incomingRecord: record, operation: headers.operation, recordMetadata, runValidations});

    if (operationSettings.unique || operationSettings.merge) {
      logger.verbose('Attempting to find matching records in the SRU');

      if (matchers.length < 0 || matchers.length !== matchOptionsList.length) {
        throw new ValidationError(HttpStatus.INTERNAL_SERVER_ERROR, {message: `There's no matcher defined, or no matchOptions for all matchers`, recordMetadata});
      }

      logger.debug(`There are ${matchers.length} matchers with matchOptions: ${JSON.stringify(matchOptionsList)}`);
      // This should use different matchOptions for merge and non-merge cases
      // stopWhenFound stops iterating matchers when a match is found
      // stopWhenFound defaults to true but it is configurable in env variable STOP_WHEN_FOUND
      // acceptZeroWithMaxCandidates: do not error case with zero matches, matchStatus: false and stopReason: maxCandidates
      // acceptZeroWithMaxCandidates defaults to true but it is configurable in env variable ACCEPT_ZERO_WITH_MAX_CANDIDATES
      const matchResult = await matcherService.iterateMatchers({matchers, matchOptionsList, record, stopWhenFound, acceptZeroWithMaxCandidates});
      const {matches, matcherReports} = matchResult;

      logger.debug(`Matches: ${JSON.stringify(matches.map(({candidate: {id}, probability}) => ({id, probability})))}`);
      logger.debug(`MatchReports: ${JSON.stringify(matcherReports)}`);

      const newHeaders = updateHeadersAfterMatch({matches, headers});


      if (matches.length > 0 && !operationSettings.merge) {
        // we log the matches here before erroring
        // Should we also validate the matches before erroring? Now we error also those cases, where the match would fail matchValidation
        const matchResultsForLog = matches.map((match, index) => ({action: false, preference: false, message: 'Validation not run', matchSequence: index, ...match}));

        logMatchAction({headers, record, matchResultsForLog, matcherReports, logNoMatches});
        throw new ValidationError(HttpStatus.CONFLICT, {message: 'Duplicates in database', ids: matches.map(({candidate: {id}}) => id), recordMetadata});
      }

      if (matches.length > 0 && operationSettings.merge) {
        logger.debug(`Found matches (${matches.length}) for merging.`);
        return validateAndMergeMatchResults({record, matchResults: matches, headers: newHeaders, matcherReports});
      }

      logger.verbose('No matching records');
      // MATCH_LOG for no matches
      logMatchAction({headers, record, matchResultsForLog: [], matcherReports, logNoMatches});

      // Note validationService = validation.js from melinda-rest-api-commons
      // which uses marc-record-validate
      // currently checks only that possible f003 has value FI-MELINDA
      // for some reason this does not work for noop CREATEs
      // Do we actually need this validation?

      const validationResults = await validationService(record);
      return {result: validationResults, recordMetadata, headers: newHeaders};
    }

    logger.debug('No unique/merge');
    const validationResults = await validationService(record);
    return {result: validationResults, recordMetadata, headers};
  }

  // eslint-disable-next-line max-statements
  async function validateAndMergeMatchResults({record, matchResults, headers, matcherReports}) {
    const {recordMetadata, cataloger} = headers;
    try {
      logger.debug(`We have matchResults (${matchResults.length}) here: ${JSON.stringify(matchResults.map(({candidate: {id}, probability}) => ({id, probability})))}`);
      logger.silly(`matchResults: ${inspect(matchResults, {colors: true, maxArrayLength: 3, depth: 2})}`);

      // run matchValidation for record & matchResults
      // -> choose the best possible match, and choose which record should be preferred in merge
      // -> error if none of the matches are valid

      // does matchValidationResult need to include record?
      // matchValidationResult: {record, result: {candidate: {id, record}, probability, matchSequence, action, preference: {value, name}}}

      const {matchValidationResult, sortedValidatedMatchResults} = await matchValidationForMatchResults(record, matchResults);
      logger.silly(`MatchValidationResult: ${inspect(matchValidationResult, {colors: true, maxArrayLength: 3, depth: 3})}}`);

      logMatchAction({headers, record, matchResultsForLog: sortedValidatedMatchResults, matcherReports});

      // Check error cases
      // Note that if we had stopWhenFound active, and did not run all the matchers because a match was found, we'll probably have cases, where we error records, that might
      // have a valid match that could be found by later matchers
      if (!matchValidationResult.result) {
        const messages = sortedValidatedMatchResults.map(match => `${match.candidate.id}: ${match.message}`);
        throw new ValidationError(HttpStatus.CONFLICT, {message: `MatchValidation for all ${sortedValidatedMatchResults.length} matches failed. ${messages.join(`, `)}`, ids: sortedValidatedMatchResults.map(match => match.candidate.id), recordMetadata});
      }

      const firstResult = matchValidationResult.result;
      logger.silly(`Result: ${inspect(firstResult, {colors: true, maxArrayLength: 3, depth: 2})}}`);

      // Do we ever get this kind of result from the matchValidation?
      if (firstResult.action === false) {
        throw new ValidationError(HttpStatus.CONFLICT, {message: `MatchValidation with ${firstResult.candidate.id} failed. ${firstResult.message}`, ids: [firstResult.candidate.id], recordMetadata});
      }

      // We don't have a matchValidationNote, because the preference information is available in the mergeNote
      logger.debug(`Action from matchValidation: ${firstResult.action}`);

      // Validate update: ie. if the update is coming from certain recordImport sources and the databaseRecord has already been updated with the incoming version of
      // the source record, we skip the update

      //Matchresult: {candidate: {id, record}, probability, matchSequence, action, preference: {value, name}}}
      const {updateValidationResult} = validateUpdate({incomingRecord: record, existingRecord: firstResult.candidate.record, cataloger});
      logger.debug(`UpdateValidationResult: ${JSON.stringify(updateValidationResult)}`);

      if (updateValidationResult === false) {
        // we do not actually want to CONFLICT this, we want to SKIPPED to this...
        logger.debug(`Update validation failed, updates from ${cataloger} are already included in the database record`);

        /*
        const newNote = `No changes detected while trying to update existing record ${updateId}, update skipped.`;
        const updatedHeaders = {
          operation: 'SKIPPED',
          notes: headers.notes ? headers.notes.concat(`${newNote}`) : [newNote]
        };
        const finalHeaders = {...headers, ...updatedHeaders};
        */
        //return {result: validationResults, recordMetadata, headers: finalHeaders};
        throw new ValidationError(HttpStatus.CONFLICT, {message: `UpdateValidation with ${firstResult.candidate.id} failed. This is actually not an error!`, ids: [firstResult.candidate.id], recordMetadata});
      }

      // run merge for record with the best valid match
      return mergeValidatedMatchResults({record, validatedMatchResult: firstResult, headers});
    } catch (err) {
      logger.debug(`MatchValidation errored`);
      logger.error(err);
      throw err;
    }
  }


  function runValidateOwnChanges({cataloger, incomingRecord, existingRecord, operation, recordMetadata, runValidations}) {
    logger.debug(`cataloger: ${JSON.stringify(cataloger)}`);
    // bulks do not currently have cataloger.id AND cataloger.authorization
    // what if we have empty authorization?
    if (cataloger.id && cataloger.authorization) {
      logger.verbose('Checking LOW-tag authorization');
      validateOwnChanges({ownTags: cataloger.authorization, incomingRecord, existingRecord, operation, recordMetadata, validate: runValidations});
      return;
    }
    logger.verbose(`No cataloger.authorization available for checking LOW-tags`);
    return;
  }

  async function mergeValidatedMatchResults({record, validatedMatchResult, headers}) {

    const {recordMetadata} = headers;

    try {

      //result: {candidate: {id, record}, probability, matchSequence, action, preference: {value, name}}}
      const {preference, candidate} = validatedMatchResult;

      // A: incoming record, B: database record
      // base: preferred record, souce: non-preferred record
      logger.verbose(`Preference for merge: Using '${preference.value}' as preferred/base record - '${preference.name}'. (A: incoming record, B: database record)`);

      // Prefer database record (B) unless we got an explicit preference for incoming record (A) from matchValidation.result

      const mergeRequest = preference.value && preference.value === 'A' ? {
        source: candidate.record,
        base: record,
        recordType
      } : {
        source: record,
        base: candidate.record,
        recordType
      };

      // mergeResult.record: merged record that can be used to update the database record
      // mergeResult.status: true

      const mergeResult = await merger(mergeRequest);
      const mergeValidationResult = {merged: mergeResult.status, mergedId: candidate.id, preference: preference.value};
      logger.debug(`Got mergeResult, created mergeValidationResult: ${JSON.stringify(mergeValidationResult)}`);

      // Should we write merge-note here?

      // Log merge-action here
      logMergeAction({headers, record, existingRecord: validatedMatchResult.candidate.record, id: validatedMatchResult.candidate.id, preference: validatedMatchResult.preference, mergeResult});

      const newHeaders = updateHeadersAfterMerge({mergeValidationResult, headers});

      logger.verbose(`PostMergeFixing merged record: ${JSON.stringify(postMergeFixOptions)}`);
      const postMergeFixedRecordObject = await fixRecord(mergeResult.record, postMergeFixOptions);

      return updateValidations({updateId: candidate.id, updateRecord: new MarcRecord(postMergeFixedRecordObject, {subfieldValues: false}), updateOperation: 'updateAfterMerge', mergeValidationResult, headers: newHeaders});
    } catch (err) {
      logger.debug(`mergeMatchResults errored: ${err}`);

      // if error was about merging try the next best valid match - we got just one match from matchValidation - in which cases merge would fail these?
      // -> if all matches error merging semantically?

      logError(err);
      const errorMessage = err.message || err.payload;
      throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, {message: `Merge errored: ${errorMessage}`, recordMetadata});
    }
  }

  function logMatchAction({headers, record, matchResultsForLog = [], matcherReports, logNoMatches = false}) {

    if (logNoMatches && matchResultsForLog.length < 1) {
      logger.debug(`No matches, logNoMatches: ${logNoMatches} - not logging matchAction to mongoLogs`);
      return;
    }

    logger.debug(`Logging the matchAction to mongoLogs here`);
    logger.silly(inspect(headers));

    const catalogerForLog = headers.cataloger.id || headers.cataloger;
    logger.debug(`Picked ${catalogerForLog} from ${JSON.stringify(headers.cataloger)}`);

    // matchResultsForLog is an array of matchResult objects:
    // {action, preference: {name, value}, message, candidate: {id, record}, probability, matchSequence}

    // add information from matcherReports to matchResults
    const matchResultsWithReports = matchResultsForLog.map((result) => {
      const matcherReportsForMatch = matcherReports.filter((matcherReport) => matcherReport && matcherReport.matchIds && matcherReport.matchIds.includes(result.candidate.id));
      logger.debug(`${JSON.stringify(matcherReportsForMatch)}`);
      return {
        ...result,
        matcherReports: matcherReportsForMatch
      };
    });

    const matchLogItem = {
      logItemType: LOG_ITEM_TYPE.MATCH_LOG,
      cataloger: catalogerForLog,
      correlationId: headers.correlationId,
      blobSequence: headers.recordMetadata.blobSequence,
      ...headers.recordMetadata,
      incomingRecord: record,
      matchResult: matchResultsWithReports,
      matcherReports
    };

    logger.silly(`MatchLogItem to add: ${inspect(matchLogItem)}`);
    mongoLogOperator.addLogItem(matchLogItem);

    return;
  }

  function logMergeAction({headers, record, preference, existingRecord, id, mergeResult}) {
    logger.silly(inspect(headers));
    logger.debug(`Logging the mergeAction to mongoLogs here`);

    const catalogerForLog = headers.cataloger.id || headers.cataloger;
    logger.debug(`Picked ${catalogerForLog} from ${JSON.stringify(headers.cataloger)}`);

    // note: there's no correlationId in headers?
    // we want also a timestamp here - mongoLogOperator could create that?

    const mergeLogItem = {
      logItemType: LOG_ITEM_TYPE.MERGE_LOG,
      cataloger: catalogerForLog,
      correlationId: headers.correlationId,
      blobSequence: headers.recordMetadata.blobSequence,
      ...headers.recordMetadata,
      databaseId: id,
      preference: {
        name: preference.name,
        value: preference.value,
        recordName: preference.value === 'A' ? 'incomingRecord' : 'databaseRecord'
      },
      incomingRecord: record,
      databaseRecord: existingRecord,
      mergedRecord: mergeResult.record
    };

    logger.silly(inspect(mergeLogItem));
    mongoLogOperator.addLogItem(mergeLogItem);

    return;
  }

  // eslint-disable-next-line max-statements
  async function mergeRecordForUpdates({record, existingRecord, id, headers}) {
    logger.debug(`Merging record ${id} to existing record ${id}`);
    const {recordMetadata} = headers;

    // Should we matchValidate this to get preference?
    // preference: 'B' : databaseRecord/exisingRecord
    const preference = {value: 'B', name: 'B is the default winner for UPDATE-merge'};

    // Currently we always prefer the databaseRecord for update-merges
    try {
      const mergeRequest = {
        source: record,
        base: existingRecord,
        recordType
      };

      // mergeResult.record: merged record that can be used to update the database record
      // mergeResult.status: true

      const mergeResult = await merger(mergeRequest);
      logger.debug(`mergeResult: ${JSON.stringify(mergeResult)}`);
      const mergeValidationResult = {merged: mergeResult.status, mergedId: id, preference: preference.value};

      // Log merge-action here
      logMergeAction({headers, record, existingRecord, id, preference, mergeResult});

      logger.verbose(`PostMergeFixing merged record: ${JSON.stringify(postMergeFixOptions)}`);
      const postMergeFixedRecordObject = await fixRecord(mergeResult.record, postMergeFixOptions);

      return {mergedRecord: new MarcRecord(postMergeFixedRecordObject, {subfieldValues: false}), headers: updateHeadersAfterMerge({mergeValidationResult, headers})};
    } catch (err) {
      logger.error(`mergeRecordForUpdates errored: ${err}`);
      logError(err);
      const errorMessage = err;
      throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, {message: `Merge errored: ${errorMessage}`, recordMetadata});
    }
  }

  function updateHeadersAfterMatch({headers, matches}) {

    // Add matchNote to headers
    const matchNote = `Found ${matches.length} matching records in the database.`;
    const updatedHeaders = {
      notes: headers.notes ? headers.notes.concat(matchNote) : [matchNote]
    };
    return {...headers, ...updatedHeaders};
  }

  function updateHeadersAfterMerge({mergeValidationResult, headers}) {

    if (mergeValidationResult && mergeValidationResult.merged) {

      // If the incoming record was merged in the validationProcess, update operation to 'UPDATE' and id mergedId

      const newOperation = OPERATIONS.UPDATE;
      const newId = mergeValidationResult.mergedId;

      // Add mergeNote
      const mergeNote = `Merged to ${newId} preferring ${mergeValidationResult.preference === 'A' ? 'incoming record.' : 'database record.'}`;
      const updatedHeaders = {
        operation: newOperation,
        id: newId,
        notes: headers.notes ? headers.notes.concat(mergeNote) : [mergeNote]
      };

      const newHeaders = {...headers, ...updatedHeaders};

      logger.debug(`validator/index/updateHeadersAfterMerge: newOperation: ${newHeaders.operation}, original operation: ${headers.operation}`);
      logger.debug(`validator/index/updateHeadersAfterMerge: newId: ${newHeaders.id}, original id: ${headers.id}`);

      return newHeaders;
    }

    // Why should we end up here?
    return headers;
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
