import HttpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ValidationError, toAlephId} from '@natlibfi/melinda-commons';
import {conversions, fixes, OPERATIONS, logError} from '@natlibfi/melinda-rest-api-commons';
import {updateField001ToParamId, getRecordMetadata, getIdFromRecord, isValidAlephId} from '../../utils';
import {inspect} from 'util';
import {MarcRecord} from '@natlibfi/marc-record';
import {logRecord} from './log-actions';
import {LOG_ITEM_TYPE} from '@natlibfi/melinda-rest-api-commons/dist/constants';

//import {AlephSequential} from '@natlibfi/marc-record-serializers';
//import {detailedDiff} from 'deep-object-diff';
import {validationsFactory} from './validations';
import {fixValidationsFactory} from './fix-validations';


//import createDebugLogger from 'debug';
//const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator');
//const debugData = debug.extend('data');

export default async function ({validatorOptions, mongoLogOperator}) {
  const logger = createLogger();
  const {preValidationFixOptions, preImportFixOptions, recordType} = validatorOptions;
  logger.debug(`preValidationFixOptions: ${JSON.stringify(preValidationFixOptions)}`);
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
  //    - delete f984 $a including any of control phases for validator
  // formerly known as formatRecord
  const {fixRecord} = fixes;

  const conversionService = conversions();
  // should we have here matcherService? commons mongo/amqp
  const {updateValidations, createValidations} = await validationsFactory(mongoLogOperator, fixRecord, validatorOptions);
  const {fixValidations} = await fixValidationsFactory(mongoLogOperator, {sruUrl: validatorOptions.sruUrl});
  //logger.debug(`Creating mongoLogOperator in ${mongoUri}`);
  //const mongoLogOperator = await mongoLogFactory(mongoUri);

  return process;

  function process(headers, data) {
    logger.debug(`--- Checking operation: ${headers.operation}---`);
    if ([OPERATIONS.CREATE, OPERATIONS.UPDATE].includes(headers.operation)) {
      logger.debug(`UPDATE/CREATE: processLoad`);
      return processLoad(headers, data);
    }
    if ([OPERATIONS.FIX].includes(headers.operation)) {
      logger.debug(`FIX: processFix`);
      return processFix(headers);
    }
    logger.debug(`Unknown operation: ${headers.operation}`);
    throw new ValidationError(HttpStatus.INTERNAL_SERVER_ERROR, {message: `Unknown operation: ${headers.operation}`});
  }

  function processFix(headers) {
    logger.debug(`process headers ${JSON.stringify(headers)}`);
    return fixValidations({headers});
  }


  // eslint-disable-next-line max-statements
  async function processLoad(headers, data) {
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

    logRecord(mongoLogOperator, {headers, record, recordMetadata: combinedRecordMetadata, logItemType: LOG_ITEM_TYPE.INPUT_RECORD_LOG, logConfig: validatorOptions.logOptions.logInputRecord});

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

    if (!validateRecords) {
      logger.verbose(`Skipped record validate/unique/merge due to operationSettings`);
      // We propably should update 001 in record to id here?
      const validatedRecord = checkAndUpdateId({record, headers: newHeaders});
      return {headers: newHeaders, data: validatedRecord.toObject()};
    }

    logger.silly(`validator/index/process: Running validations for (${newHeaders.recordMetadata.sourceId})`);
    logger.debug(`validator/index/process: ${JSON.stringify(newHeaders)}`);

    try {
      const {result, recordMetadata, headers: resultHeaders} = await executeValidations({record, headers: newHeaders});

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

      // Final validation : record is valid according to marcRecord and convertible to alephSequential
      const alephValidatedRecordObject = await alephValidateRecord(fixedRecordObject);

      return {headers: resultHeaders, data: alephValidatedRecordObject};

    } catch (err) {
      logger.debug(`validateRecord: validation errored: ${JSON.stringify(err)}`);
      if (err instanceof ValidationError) {
        logger.debug(`Error is a validationError.`);
        const {status, payload} = err;
        const newPayload = {
          recordMetadata: newHeaders.recordMetadata,
          ...payload
        };
        logger.debug(`Payload from error: ${JSON.stringify(payload)}`);
        logger.debug(`New payload: ${JSON.stringify(newPayload)}`);
        throw new ValidationError(status, newPayload);
      }
      throw new Error(err);
    }

    function alephValidateRecord(recordObject) {
      try {
        logger.debug(`---- alephValidate -----`);
        logger.debug(`Validating that resulting record is a valid marcRecord and convertable to alephSequential`);
        // We could have more strict validationOptions if we'd like to check everything?
        const record = new MarcRecord(recordObject, {subfieldValues: false});
        const alephSequential = conversionService.serialize(record, 'ALEPHSEQ');
        //const record = new MarcRecord(recordObject, {subfieldValues: false});
        //const alephSequential = AlephSequential.to(record);
        logger.silly(alephSequential);
        return recordObject;
      } catch (error) {
        logger.debug(`validation of marcRecord+AlephSequential failed: ${error}`);
        logError(error);
        logger.debug(JSON.stringify(error));
        const message = error.message || error.payload?.message || error.payload;
        const cleanErrorMessage = message.replace(/(?<lineBreaks>\r\n|\n|\r)/gmu, ' ');
        //logger.silly(`${cleanErrorMessage}`);
        throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, {message: `Error in record. ${cleanErrorMessage}`, recordMetadata});
      }
    }

    function executeValidations({record, headers}) {
      logger.debug('Validating the record');

      if (headers.operation === OPERATIONS.UPDATE) {
        return updateValidations({updateId: headers.id, updateRecord: record, updateOperation: headers.operation, headers});
      }

      return createValidations({record, headers});
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
      const unzerialized = await conversionService.unserialize(data, format);
      logger.silly(`Unserialized data: ${JSON.stringify(unzerialized)}`);
      // Format record - currently for bibs edit $0 and $w ISILs to Aleph internar library codes
      const recordObject = await fixRecord(unzerialized, preValidationFixOptions);
      logger.silly(`Formated recordObject:\n${JSON.stringify(recordObject)}`);
      //return new MarcRecord(recordObject, {subfieldValues: false});
      return new MarcRecord(recordObject, {subfieldValues: false});
    } catch (err) {
      logger.debug(`unserializeAndFormatRecord errored:`);
      logError(err);
      logger.debug(JSON.stringify(err));
      const message = err.message || err.payload?.message || err.payload;
      const cleanErrorMessage = message.replace(/(?<lineBreaks>\r\n|\n|\r)/gmu, ' ');
      //logger.silly(`${cleanErrorMessage}`);
      throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, {message: `Parsing input data failed. ${cleanErrorMessage}`, recordMetadata});
    }
  }
}
