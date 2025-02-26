import {promisify, inspect} from 'util';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {mongoFactory, amqpFactory, logError, LOG_ITEM_TYPE, QUEUE_ITEM_STATE, IMPORT_JOB_STATE, OPERATIONS, createRecordResponseItem, addRecordResponseItem, mongoLogFactory} from '@natlibfi/melinda-rest-api-commons';
import validatorFactory from './interfaces/validator';
import toMarcRecordFactory from './interfaces/toMarcRecords';
import httpStatus from 'http-status';
import {logRecord} from './interfaces/validator/log-actions';

const setTimeoutPromise = promisify(setTimeout);

export default async function ({
  pollRequest, pollWaitTime, amqpUrl, mongoUri, validatorOptions, splitterOptions, recordType
}) {
  const logger = createLogger();
  const collection = pollRequest ? 'prio' : 'bulk';
  const prio = pollRequest;
  const mongoOperator = await mongoFactory(mongoUri, collection);
  // secord parameter is true for running amqpHealthCheck, which errors if channel and/or connection gets closed
  const amqpOperator = await amqpFactory(amqpUrl, true);
  const mongoLogOperator = await mongoLogFactory(mongoUri);
  const validator = await validatorFactory({validatorOptions, mongoLogOperator});
  const toMarcRecords = await toMarcRecordFactory({amqpOperator, mongoOperator, mongoLogOperator, splitterOptions});

  logger.info(`Started Melinda-rest-api-validator: ${pollRequest ? 'PRIORITY' : 'BULK'} for ${recordType} records`);
  logger.debug(`Poll wait time: ${pollWaitTime} is ${typeof pollWaitTime}`);

  const server = await initCheck();

  return server;

  // Main loop for validator
  async function initCheck(wait = false) {
    if (wait) {
      await setTimeoutPromise(pollWaitTime);
      return initCheck();
    }
    logger.silly('Initiating check');

    // Prio Validator checks requests from amqpQueue REQUESTS
    if (pollRequest) {
      logger.silly(`Going to checkAmqp for priority requests`);
      return checkAmqpForRequests({mongoOperator, amqpOperator, prio});
    }

    // Bulk Validator checks Mongo for bulk queueItems in state VALIDATOR.PENDING_QUEUING and in state VALIDATOR.PENDING_VALIDATION and VALIDATOR.VALIDATING
    return checkMongo({mongoOperator, amqpOperator, prio});
  }

  // Check amqp for jobs in 'REQUESTS' AMQP queue for prio
  async function checkAmqpForRequests({mongoOperator, amqpOperator, prio}) {
    logger.silly('Checking amqp');
    const message = await amqpOperator.checkQueue({queue: 'REQUESTS', style: 'one', toRecord: false, purge: false});
    logger.silly(`Message: ${inspect(message, {colors: true, maxArrayLength: 3, depth: 2})}`);

    try {
      if (message) {
        return await handleMessage({message, mongoOperator, amqpOperator, prio});
      }
      // No job found
      return initCheck(true);

    } catch (error) {
      logger.debug(`checkAmqpqueue errored: ${JSON.stringify(error)}`);

      // We cannot ackMessages or setStates if we do not have a message
      if (message) {
        const {correlationId, headers} = message.properties;
        logger.silly(`correlationId: ${correlationId}`);
        await amqpOperator.ackMessages([message]);

        return setError({headers, error, correlationId, mongoOperator, prio});
      }

      logError(error);

      // If we had an ApiError even without message, we can retry
      if (error instanceof ApiError) {
        return initCheck(true);
      }

      // otherwise throw error
      // This should handle cases where amqp errors f.e. 'IllegalOperationError: Channel closed'
      throw error;
    }
  }


  // Check amqp for records in PENDING_VALIDATION.correlationId  AMQP queue for bulk
  // eslint-disable-next-line max-statements
  async function checkAmqpForBulkPendingValidation({correlationId, mongoOperator, amqpOperator, prio, noop}) {
    logger.silly('Checking amqp');
    const validatorQueue = `PENDING_VALIDATION.${correlationId}`;
    const message = await amqpOperator.checkQueue({queue: validatorQueue, style: 'one', toRecord: false, purge: false});
    logger.silly(`Message: ${inspect(message, {colors: true, maxArrayLength: 3, depth: 2})}`);

    try {
      if (message) {
        // all bulk messages are 'fresh', timeOut is not checked for them
        return await processFreshMessage({message, mongoOperator, amqpOperator, prio});
      }

      logger.debug(`No (more) messages in ${validatorQueue}, validation for bulk job ${correlationId} done (Noop: ${noop}).`);

      if (noop) {
        await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.DONE});
        return initCheck();
      }

      /*
      const messagesInCreateQueue = await amqpOperator.checkQueue({queue: `CREATE.${correlationId}`, style: 'messages'});
      const messagesInUpdateQueue = await amqpOperator.checkQueue({queue: `UPDATE.${correlationId}`, style: 'messages'});

      if (messagesInCreateQueue || messagesInUpdateQueue) {

      }
      */

      // this should check whether we have anything in queues?
      // possibly also set importQueueStates here, so we don't need to set them everytime?

      await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.IMPORTER.IN_QUEUE});

      amqpOperator.removeQueue(validatorQueue);
      return initCheck();

    } catch (error) {
      logger.debug(`checkAmqpqueueForBulkPendinValidation errored: ${JSON.stringify(error)}`);

      // We cannot ackMessages we do not have a message
      if (message) {
        const {correlationId, headers} = message.properties;
        logger.silly(`correlationId: ${correlationId}`);
        await amqpOperator.ackMessages([message]);

        return setError({headers, error, correlationId, mongoOperator, prio});
      }

      logError(error);

      // If we had an ApiError even without message, we can retry
      if (error instanceof ApiError) {
        return initCheck(true);
      }

      // otherwise throw error
      // This should handle cases where amqp errors f.e. 'IllegalOperationError: Channel closed'
      throw error;
    }
  }

  async function handleMessage({message, mongoOperator, amqpOperator, prio}) {
    // logger.debug(`app/chechAmqp: Found message: ${JSON.stringify(message)}`);
    // Work with message
    const {correlationId} = message.properties;
    logger.debug(`app/checkAmqp: Found message for correlationId: ${correlationId}`);

    // checkAndSetState checks that the queueItem is not too old, sets state and return true if okay
    // http, did createPrio in state QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION
    // this is just for prio

    const fresh = await mongoOperator.checkAndSetState({correlationId, state: QUEUE_ITEM_STATE.VALIDATOR.VALIDATING});
    if (fresh) {
      return processFreshMessage({message, mongoOperator, amqpOperator, prio});
    }
    // queueItem was too old, queueItem was set to ABORT
    await amqpOperator.ackMessages([message]);
    return initCheck();
  }

  async function processFreshMessage({message, mongoOperator, amqpOperator, prio}) {

    // different contents in headers here? batchBulk has just format
    const {headers, correlationId} = message.properties;

    // content data: streambulk: recordObject, prio & batchbulk: messageBody to unserializeAndFormat to record
    //               prioFix: empty, bulkFix: messageBody to format to AlephSysList
    const messageContentString = message.content.toString();
    logger.silly(`messageContentString: ${messageContentString}`);

    const content = JSON.parse(messageContentString);

    logger.silly(`app/checkAmqp: content ${content}`);
    //logger.silly(`app/checkAmqp: content ${inspect(content, {colors: true, maxArrayLength: 3, depth: 1})}}`);

    // validator.process returns: {headers, data}

    logger.silly(`app/checkAmqp: Actually validating`);
    const processResult = await validator(headers, content.data);
    // If not-noop and validator.process fails, it errors
    // for noop failing marc-record-validate return result.failed: true
    logger.debug(`app/checkAmqp: Validation process results: ${inspect(processResult, {colors: true, maxArrayLength: 3, depth: 1})}`);
    logger.debug(`app/checkAmqp: Validation process results (headers): ${JSON.stringify(processResult.headers)}`);

    await amqpOperator.ackMessages([message]);

    const {operation} = processResult.headers;
    logger.debug(`OPERATION: ${operation}`);

    if ([OPERATIONS.FIX].includes(operation)) {
      return processValidatedFix({headers, correlationId, processResult, mongoOperator, prio});
    }

    return processValidatedLoad({headers, correlationId, processResult, mongoOperator, prio});

    // Note: we have also operations SKIPPED_CHANGE, SKIPPED_UPDATE at this point!
    //if ([OPERATIONS.UPDATE, OPERATIONS.CREATE].includes(operation)) {
    //  return processValidatedLoad({headers, correlationId, processResult, mongoOperator, prio});
    //}

    //throw new Error(httpStatus.INTERNAL_SERVER_ERROR, `Unknown operation ${operation}`);
  }

  async function processValidatedLoad({headers, correlationId, processResult, mongoOperator, prio}) {
    logger.debug(`app/processValidated: operation: ${processResult.headers.operation}`);
    if (['SKIPPED', 'SKIPPED_CHANGE', 'SKIPPED_UPDATE'].includes(processResult.headers.operation)) {
      // we do not log resultRecord for skipResults
      return setSkipResult({correlationId, processResult, mongoOperator, prio});
    }

    // logResultRecord
    logger.silly(`app/processValidated: processResult: ${inspect(processResult)}`);
    logRecord(mongoLogOperator, {headers: processResult.headers, record: processResult.data, recordMetadata: processResult.headers.recordMetadata, logItemType: LOG_ITEM_TYPE.RESULT_RECORD_LOG, logConfig: validatorOptions.logOptions.logResultRecord});

    // check if validation changed operation
    await setOperationsInQueueItem({correlationId, mongoOperator, prio, addOperation: processResult.headers.operation, removeOperation: headers.operation});

    const {noop} = headers.operationSettings;
    logger.silly(`app/processValidated: noop ${noop}`);

    if (noop) {
      logger.debug(`FOO`);
      return setNoopResult({correlationId, processResult, mongoOperator, prio});
    }

    return setNormalResult({correlationId, processResult, mongoOperator, prio});
  }

  function processValidatedFix({headers, correlationId, processResult, mongoOperator, prio}) {
    logger.debug(`app/processValidatedFix: operation: ${processResult.headers.operation}`);

    const {noop} = headers.operationSettings;
    logger.silly(`app/processValidatedFix: noop ${noop}`);

    if (noop) {
      return setNoopResult({correlationId, processResult, mongoOperator, prio});
    }

    return setNormalResult({correlationId, processResult, mongoOperator, prio});
  }

  async function setOperationsInQueueItem({correlationId, mongoOperator, prio, addOperation, removeOperation}) {

    if (addOperation === removeOperation) {
      return;
    }

    logger.debug(`Validation changed operation from ${removeOperation} to ${addOperation}`);
    if (prio) {
      await mongoOperator.setOperation({correlationId, operation: addOperation});
      await mongoOperator.setOperations({correlationId, addOperation, removeOperation});
      return;
    }
    if (!prio) {
      await mongoOperator.setOperations({correlationId, addOperation});
      return;
    }
  }

  async function setNormalResult({correlationId, processResult, mongoOperator, prio}) {
    const newOperation = processResult.headers.operation;
    const operationQueue = `${newOperation}.${correlationId}`;
    logger.debug(JSON.stringify(newOperation));
    logger.debug(JSON.stringify(operationQueue));

    // eslint-disable-next-line functional/no-conditional-statements
    if (prio) {
      // empty prio queue
      await amqpOperator.checkQueue({queue: operationQueue, style: 'messages', purge: true});
    }

    logger.debug(`Next sendtoQueue`);

    // Normal (non-noop and not NO_CHANGES) data to queue operation.correlationId
    const toQueue = {
      correlationId,
      queue: operationQueue,
      headers: processResult.headers,
      data: processResult.data
    };

    logger.debug(`app/setNormalResult: sending to queue ${inspect(toQueue, {colors: true, maxArrayLength: 3, depth: 4})}`);
    await amqpOperator.sendToQueue(toQueue);
    logger.debug(`MongoOperator: ${JSON.stringify(mongoOperator)}`);

    if (prio) {
      await mongoOperator.checkAndSetImportJobState({correlationId, operation: newOperation, importJobState: IMPORT_JOB_STATE.IN_QUEUE});
      await mongoOperator.checkAndSetState({correlationId, state: QUEUE_ITEM_STATE.IMPORTER.IN_QUEUE});
      return initCheck();
    }

    if (!prio) {
      await mongoOperator.setImportJobState({correlationId, operation: newOperation, importJobState: IMPORT_JOB_STATE.IN_QUEUE});
      return initCheck();
    }

    // we should not end up here
    return initCheck();
  }

  async function setSkipResult({correlationId, processResult, mongoOperator, prio}) {

    logger.debug(`setSkipResult`);
    const status = processResult.headers.operation;
    const {id} = processResult.headers;
    const {noop} = processResult.headers.operationSettings;

    logger.silly(inspect(processResult));

    const {notes} = processResult.headers;
    const notesString = notes && Array.isArray(notes) && notes.length > 0 ? `${notes.join(' - ')}` : '';

    const responsePayload = noop === true ? {message: `${notesString} - Noop.`} : {message: `${notesString}`};

    const recordResponseItem = createRecordResponseItem({responseStatus: status, responsePayload, recordMetadata: processResult.headers.recordMetadata, id});
    await addRecordResponseItem({recordResponseItem, correlationId, mongoOperator});

    // Remove logItems for SKIPPED records to save space in Mongo
    // (Move to an independent function)
    // We probably remove also inputRecordLogs here?
    const {blobSequence} = processResult.headers.recordMetadata;
    mongoLogOperator.removeBySequences(correlationId, [blobSequence]);

    if (prio) {
      await mongoOperator.checkAndSetState({correlationId, state: QUEUE_ITEM_STATE.DONE});
      return initCheck();
    }

    return initCheck();
  }

  function setNoopResult({correlationId, processResult, mongoOperator, prio}) {
    logger.debug(`correlationId: ${correlationId}`);
    logger.debug(`processResult ${JSON.stringify(processResult)}`);
    logger.debug(`mongoOperator: ${JSON.stringify(mongoOperator)}`);
    logger.debug(`Prio: ${JSON.stringify(prio)}`);

    if (processResult.headers.operation === OPERATIONS.FIX) {
      return setNoopResultFix({correlationId, processResult, mongoOperator, prio});
    }
    return setNoopResultLoad({correlationId, processResult, mongoOperator, prio});
  }


  async function setNoopResultLoad({correlationId, processResult, mongoOperator, prio}) {

    logger.debug(`Setting noop result`);
    const status = processResult.headers.operation === 'CREATE' ? 'CREATED' : 'UPDATED';
    const id = processResult.headers.operation === 'CREATE' ? '000000000' : processResult.headers.id;

    logger.silly(inspect(processResult));

    const {notes} = processResult.headers;
    const notesString = notes && Array.isArray(notes) && notes.length > 0 ? `${notes.join(' - ')} - ` : '';

    const messageStart = status === 'CREATED' ? `Would create a new record.` : `Would update record ${id}.`;
    const messageEnd = ` - Noop.`;

    const responsePayload = {message: `${notesString}${messageStart}${messageEnd}`};

    const recordResponseItem = createRecordResponseItem({responseStatus: status, responsePayload, recordMetadata: processResult.headers.recordMetadata, id});
    await addRecordResponseItem({recordResponseItem, correlationId, mongoOperator});

    if (prio) {
      await mongoOperator.checkAndSetState({correlationId, state: QUEUE_ITEM_STATE.DONE});
      return initCheck();
    }

    return initCheck();
  }

  async function setNoopResultFix({correlationId, processResult, mongoOperator, prio}) {

    logger.debug(`Setting noop result`);
    const status = 'FIXED';
    const {id} = processResult.headers;
    const {fixType} = processResult.headers.operationSettings;


    logger.silly(inspect(processResult));

    const {notes} = processResult.headers;
    const notesString = notes && Array.isArray(notes) && notes.length > 0 ? `${notes.join(' - ')} - ` : '';

    const messageStart = `Would fix (${fixType}) record ${id}.`;
    const messageEnd = ` - Noop.`;

    const responsePayload = {message: `${notesString}${messageStart}${messageEnd}`};

    const recordResponseItem = createRecordResponseItem({responseStatus: status, responsePayload, recordMetadata: processResult.headers.recordMetadata, id});

    logger.debug(`Add record response item to Mongo`);
    logger.debug(`recordResponseItem: ${JSON.stringify(recordResponseItem)}`);
    logger.debug(`correlationId: ${JSON.stringify(correlationId)}`);
    logger.debug(`mongoOperator: ${JSON.stringify(mongoOperator)}`);


    await addRecordResponseItem({recordResponseItem, correlationId, mongoOperator});

    if (prio) {
      await mongoOperator.checkAndSetState({correlationId, state: QUEUE_ITEM_STATE.DONE});
      return initCheck();
    }

    return initCheck();
  }


  async function setError({error, correlationId, mongoOperator, prio, headers = undefined}) {

    logger.debug(`Headers from original message: ${JSON.stringify(headers)}`);

    logger.silly(`error.status: ${error.status}`);
    const responseStatus = error.status || httpStatus.INTERNAL_SERVER_ERROR;
    logger.debug(`responseStatus: ${responseStatus}`);

    logger.silly(`error.message: ${error.message}, error.payload: ${error.payload}`);
    const responseMessage = error.message || error.payload.message || 'Unexpected error!';
    logger.debug(`responseMessage: ${JSON.stringify(responseMessage)}`);

    const responsePayload = error.payload || {message: responseMessage} || undefined;
    logger.debug(`responsePayload: ${JSON.stringify(responsePayload)}`);

    const recordMetadataFromMessageHeaders = headers.recordMetadata || undefined;
    const recordMetadataFromError = responsePayload ? responsePayload.recordMetadata : undefined;

    const responseRecordMetadata = recordMetadataFromError || recordMetadataFromMessageHeaders;

    // Add recordResponse to queueItem
    const recordResponseItem = createRecordResponseItem({responseStatus, responsePayload, recordMetadata: responseRecordMetadata, id: headers.operation === OPERATIONS.CREATE ? '000000000' : headers.id});
    await addRecordResponseItem({recordResponseItem, correlationId, mongoOperator});

    // If we had a message we can move to next message
    if (prio) {
      await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.ERROR, errorStatus: responseStatus, errorMessage: responsePayload});
      return initCheck(true);
    }
    return initCheck(true);
  }


  // Check Mongo for jobs
  // eslint-disable-next-line max-statements
  async function checkMongo({mongoOperator, amqpOperator, prio}) {

    // bulk jobs for validation
    const queueItemValidating = await mongoOperator.getOne({queueItemState: QUEUE_ITEM_STATE.VALIDATOR.VALIDATING});

    if (queueItemValidating) {
      logger.silly('Mongo queue item found');
      // do we need to forward other stuff from queuItem? batchBulk validatorQueue messages have just format in headers?
      // as comparison prioMessages in PENDING_VALIDATION.correlationId queue have more complete headers
      const {correlationId, operationSettings} = queueItemValidating;
      return checkAmqpForBulkPendingValidation({correlationId, mongoOperator, amqpOperator, prio, noop: operationSettings.noop});
    }

    const queueItemPendingValidation = await mongoOperator.getOne({queueItemState: QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION});

    if (queueItemPendingValidation) {
      logger.silly('Mongo queue item found');
      const {correlationId, operationSettings} = queueItemPendingValidation;
      await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.VALIDATOR.VALIDATING});
      return checkAmqpForBulkPendingValidation({correlationId, mongoOperator, amqpOperator, prio, noop: operationSettings.noop});
    }

    // bulk job for splitting stream to records
    const queueItemPendingQueuing = await mongoOperator.getOne({queueItemState: QUEUE_ITEM_STATE.VALIDATOR.PENDING_QUEUING});
    if (queueItemPendingQueuing) {
      logger.silly('Mongo queueItem found');
      // Work with queueItem
      const {correlationId, operation, contentType, cataloger, operationSettings} = queueItemPendingQueuing;
      logger.silly(`Correlation id: ${correlationId}`);
      // Set Mongo job state
      await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.VALIDATOR.QUEUING_IN_PROGRESS});

      try {
        // Get stream from content
        const stream = await mongoOperator.getStream(correlationId);

        logger.debug(`OperationSettings: ${JSON.stringify(operationSettings)}`);
        const validateRecords = operationSettings.validate || operationSettings.merge || operationSettings.unique || false;
        const failOnError = operationSettings.failOnError === undefined ? undefined : operationSettings.failOnError;
        const noop = operationSettings.noop || false;

        // Read stream to MarcRecords and send em to queue
        // This is a promise that resolves when all the records are in queue and (currently always, this should be set by operationSettings.failOnError) rejects if any of the records in the stream fail
        logger.debug(`Some operationSettings: validateRecord: ${validateRecords}, failOnError: ${failOnError}, noop: ${noop}`);
        await toMarcRecords.streamToRecords({correlationId, headers: {correlationId, operation, cataloger, operationSettings}, contentType, stream, validateRecords, failOnError, noop});

        // setState to VALIDATOR.PENDING_VALIDATION if we're validating the bulk job
        // setState to IMPORTER.IN_QUEUE if we're not validating the bulk job

        if (noop && !validateRecords) {
          await await mongoOperator.setState({correlationId, state: 'DONE'});
          return initCheck();
        }

        const newState = validateRecords ? QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION : QUEUE_ITEM_STATE.IMPORTER.IN_QUEUE;
        await mongoOperator.setState({correlationId, state: newState});
        if (!validateRecords) {
          await mongoOperator.setImportJobState({correlationId, operation, importJobState: IMPORT_JOB_STATE.IN_QUEUE});
          return initCheck();
        }

      } catch (error) {
        if (error instanceof ApiError) {
          logger.debug(`validator/app/checkMongo errored ${JSON.stringify(error)} in ${correlationId}`);
          await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.ERROR, errorMessage: error.payload, errorStatus: error.status});

          return initCheck();
        }
        // If error is not ApiError, queueItem is stuck in QUEUEING_IN_PROGRESS - should this be handled somehow
        logError(error);
        throw new Error(error);
      }

      return initCheck();
    }

    // No job found
    return initCheck(true);
  }

}
