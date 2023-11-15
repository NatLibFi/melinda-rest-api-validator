import HttpStatus from 'http-status';
import {MarcRecord} from '@natlibfi/marc-record';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ValidationError} from '@natlibfi/melinda-commons';
import {validations, logError, OPERATIONS} from '@natlibfi/melinda-rest-api-commons';
import createMatchInterface from '@natlibfi/melinda-record-matching';
import createSruClient from '@natlibfi/sru-client';
import {inspect} from 'util';

import {logMergeAction, logMatchAction, getCatalogerForLog} from './log-actions';
import * as matcherService from './match';
import {matchValidationForMatchResults} from './match-validation';
import merger from './merge';
import validateOwnChanges from './own-authorization';
import {validateChanges} from './validate-changes';
import {validateExistingRecord} from './validate-existing-record';
import {validateRecordState} from './validate-record-state';
import {validateUpdate} from './validate-update';
import {getRecord} from '../../utils';

const logger = createLogger();

export async function validationsFactory(
  mongoLogOperator,
  fixRecord,
  {
    sruUrl,
    recordType,
    postMergeFixOptions,
    matchOptionsList,
    stopWhenFound,
    acceptZeroWithMaxCandidates,
    logOptions
  }
) {
  logger.debug(`postMergeFixOptions: ${JSON.stringify(postMergeFixOptions)}`);

  // validationService: marc-record-validate validations from melinda-rest-api-commons
  const validationService = await validations();
  const sruClient = createSruClient({url: sruUrl, recordSchema: 'marcxml', retrieveAll: false, maximumRecordsPerRequest: 1});
  const matchers = matchOptionsList.map(matchOptions => createMatchInterface(matchOptions));
  logger.debug(`We created ${matchers.length} matchers`);

  return {updateValidations, createValidations};

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
      // -> updating f001 is done later in validateRecord, so it gets done to other CREATE operation too

      logger.verbose(`Reading record ${updateId} from SRU for ${headers.correlationId}`);
      const existingRecord = await getRecord(sruClient, updateId);
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
          operation: 'SKIPPED_CHANGE',
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

        logMatchAction(mongoLogOperator, {headers, record, matchResultsForLog, matcherReports, logNoMatches: logOptions.logNoMatches});
        throw new ValidationError(HttpStatus.CONFLICT, {message: 'Duplicates in database', ids: matches.map(({candidate: {id}}) => id), recordMetadata});
      }

      if (matches.length > 0 && operationSettings.merge) {
        logger.debug(`Found matches (${matches.length}) for merging.`);
        return validateAndMergeMatchResults({record, matchResults: matches, headers: newHeaders, matcherReports});
      }

      logger.verbose('No matching records');
      // MATCH_LOG for no matches
      logMatchAction(mongoLogOperator, {headers, record, matchResultsForLog: [], matcherReports, logNoMatches: logOptions.logNoMatches});

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
      logMergeAction(mongoLogOperator, {headers, record, existingRecord, id, preference, mergeResult});

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

      logMatchAction(mongoLogOperator, {headers, record, matchResultsForLog: sortedValidatedMatchResults, matcherReports});

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
      const catalogerForLog = getCatalogerForLog(headers.cataloger);

      if (updateValidationResult === false) {
        logger.debug(`Update validation failed, updates from ${catalogerForLog} are already included in the database record`);

        const newNote = `No new incoming changes from ${catalogerForLog} detected while trying to update existing record ${firstResult.candidate.id}, update skipped.`;
        const updatedHeaders = {
          operation: 'SKIPPED_UPDATE',
          notes: headers.notes ? headers.notes.concat(`${newNote}`) : [newNote],
          id: firstResult?.candidate?.id || headers.id
        };
        const finalHeaders = {...headers, ...updatedHeaders};
        return {result: {record, validationResult: false}, recordMetadata, headers: finalHeaders};
        //throw new ValidationError(HttpStatus.CONFLICT, {message: `UpdateValidation with ${firstResult.candidate.id} failed. This is actually not an error!`, ids: [firstResult.candidate.id], recordMetadata});
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
      logMergeAction(mongoLogOperator, {headers, record, existingRecord: validatedMatchResult.candidate.record, id: validatedMatchResult.candidate.id, preference: validatedMatchResult.preference, mergeResult});

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
}
