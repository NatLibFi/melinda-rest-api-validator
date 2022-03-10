import {promisify, inspect} from 'util';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {mongoFactory, amqpFactory, logError, QUEUE_ITEM_STATE, IMPORT_JOB_STATE} from '@natlibfi/melinda-rest-api-commons';
import validatorFactory from './interfaces/validator';
import toMarcRecordFactory from './interfaces/toMarcRecords';

const setTimeoutPromise = promisify(setTimeout);

export default async function ({
  pollRequest, pollWaitTime, amqpUrl, mongoUri, validatorOptions, splitterOptions
}) {
  const logger = createLogger();
  const collection = pollRequest ? 'prio' : 'bulk';
  const prio = pollRequest;
  const mongoOperator = await mongoFactory(mongoUri, collection);
  const amqpOperator = await amqpFactory(amqpUrl);
  const validator = await validatorFactory(validatorOptions);
  const toMarcRecords = await toMarcRecordFactory(amqpOperator, mongoOperator, splitterOptions);

  logger.info(`Started Melinda-rest-api-validator: ${pollRequest ? 'PRIORITY' : 'BULK'}`);

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
  async function checkAmqpForRequests({prio}) {
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

    const {headers} = message.properties;
    const {correlationId} = message.properties;

    const content = JSON.parse(message.content.toString());

    logger.silly(`app/checkAmqp: content ${inspect(content, {colors: true, maxArrayLength: 3, depth: 1})}}`);
    // validator.process returns:
    //     no-noop: {headers: {operation, cataloger: cataloger.id, sourceId, blobF001}, data: result.record.toObject()};
    //     noop:    {status, record, failed, messages} - no headers!

    logger.silly(`app/checkAmqp: Actually validating`);
    const processResult = await validator.process(headers, content.data);
    // If not-noop and validator.process fails, it errors
    // for noop failing marc-record-validate return result.failed: true
    logger.debug(`app/checkAmqp: Validation successfully done`);
    logger.debug(`app/checkAmqp: Validation process results: ${inspect(processResult, {colors: true, maxArrayLength: 3, depth: 1})}`);
    logger.silly(`app/checkAmqp: Validation process results: ${JSON.stringify(processResult)}`);

    await amqpOperator.ackMessages([message]);
    return processValidated({headers, correlationId, processResult, mongoOperator, prio});
  }

  async function processValidated({headers, correlationId, processResult, mongoOperator, prio}) {
    // Process validated data
    // noops are DONE here

    // bulks probably don't have noop?
    const {noop} = headers;
    logger.debug(`app/checkAmqp: noop ${noop}`);

    // Validator could change the operation type
    // eslint-disable-next-line functional/no-conditional-statement
    if (processResult.headers !== undefined && processResult.headers.operation !== headers.operation) {
      logger.debug(`Validation changed operation from ${headers.operation} to ${processResult.headers.operation}`);

      // eslint-disable-next-line functional/no-conditional-statement
      if (prio) {
        await mongoOperator.setOperation({correlationId, operation: processResult.headers.operation});
        await mongoOperator.setOperations({correlationId, addOperation: processResult.headers.operation, removeOperation: headers.operation});
      }
      // eslint-disable-next-line functional/no-conditional-statement
      if (!prio) {
        await mongoOperator.setOperations({correlationId, addOperation: processResult.headers.operation});
      }

    }

    if (noop) {
      return setNoopResult({headers, correlationId, processResult, mongoOperator, prio});
    }

    return setNormalResult({headers, correlationId, processResult, mongoOperator, prio});
  }

  async function setNormalResult({headers, correlationId, processResult, mongoOperator, prio}) {
    const newOperation = processResult.headers.operation;
    const operationQueue = `${newOperation}.${correlationId}`;

    // eslint-disable-next-line functional/no-conditional-statement
    if (prio) {
      await amqpOperator.checkQueue({queue: operationQueue, style: 'messages', purge: true});
    }

    // Normal (non-noop) data to queue operation.correlationId
    const toQueue = {
      correlationId,
      queue: operationQueue,
      headers: processResult.headers || headers,
      data: processResult.data
    };


    logger.silly(`app/checkAmqp: sending to queue ${inspect(toQueue, {colors: true, maxArrayLength: 3, depth: 1})}`);
    await amqpOperator.sendToQueue(toQueue);

    // eslint-disable-next-line functional/no-conditional-statement
    if (prio) {
      logger.debug(`FOO`);
      await mongoOperator.checkAndSetImportJobState({correlationId, operation: newOperation, importJobState: IMPORT_JOB_STATE.IN_QUEUE});
      await mongoOperator.checkAndSetState({correlationId, state: QUEUE_ITEM_STATE.IMPORTER.IN_QUEUE});
    }

    // eslint-disable-next-line functional/no-conditional-statement
    if (!prio) {
      await mongoOperator.setImportJobState({correlationId, operation: newOperation, importJobState: IMPORT_JOB_STATE.IN_QUEUE});
    }

    return initCheck();
  }

  // do we have noops for bulk?
  async function setNoopResult({correlationId, processResult, mongoOperator, prio}) {

    const status = processResult.headers.operation === 'CREATE' ? 'CREATED' : 'UPDATED';
    const validationMessage = {status, failed: processResult.failed, messages: processResult.messages ? processResult.messages.concat(processResult.mergeValidationResult) : [processResult.mergeValidationResult]};
    logger.debug(`${JSON.stringify(validationMessage)}`);

    await mongoOperator.pushMessages({correlationId, messageField: 'noopValidationMessages', messages: [validationMessage]});
    // eslint-disable-next-line functional/no-conditional-statement
    if (prio) {
      await mongoOperator.checkAndSetState({correlationId, state: QUEUE_ITEM_STATE.DONE});
    }
    return initCheck();
  }

  async function setError({error, correlationId, mongoOperator, prio, headers = undefined}) {

    logger.debug(`Headers: ${JSON.stringify(headers)}`);

    logger.silly(`error.status: ${error.status}`);
    const responseStatus = error.status || '500';
    logger.debug(`responseStatus: ${responseStatus}`);

    logger.silly(`error.message: ${error.message}, error.payload: ${error.payload}`);
    const responsePayload = error.message || error.payload || 'Unexpected error!';
    logger.debug(`responsePayload: ${JSON.stringify(responsePayload)}`);

    // eslint-disable-next-line functional/no-conditional-statement
    if (prio) {
      await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.ERROR, errorStatus: responseStatus, errorMessage: responsePayload});
    }

    // for bulk, push validatorErrors to validatorErrorMessages - we need better handling for this
    // eslint-disable-next-line functional/no-conditional-statement
    logger.debug(`Validator error (specially for bulk) for bulk`);
    const errorHeaders = {sourceId: headers.sourceId, sequence: headers.blobf001};
    await mongoOperator.pushMessages({correlationId, messages: [{errorHeaders, error}], messageField: 'validatorErrors'});

    // If we had a message we can move to next message
    return initCheck(true);
  }

  // Check Mongo for jobs
  // eslint-disable-next-line max-statements
  async function checkMongo({mongoOperator, amqpOperator, prio}) {

    //logger.silly(prio);

    const queueItemValidating = await mongoOperator.getOne({queueItemState: QUEUE_ITEM_STATE.VALIDATOR.VALIDATING});

    if (queueItemValidating) {
      logger.silly('Mongo queue item found');
      const {correlationId, noop} = queueItemValidating;
      return checkAmqpForBulkPendingValidation({correlationId, mongoOperator, amqpOperator, prio, noop});
    }

    const queueItemPendingValidation = await mongoOperator.getOne({queueItemState: QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION});

    if (queueItemPendingValidation) {
      logger.silly('Mongo queue item found');
      const {correlationId, noop} = queueItemPendingValidation;
      await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.VALIDATOR.VALIDATING});
      return checkAmqpForBulkPendingValidation({correlationId, mongoOperator, amqpOperator, prio, noop});
    }

    const queueItemPendingQueuing = await mongoOperator.getOne({queueItemState: QUEUE_ITEM_STATE.VALIDATOR.PENDING_QUEUING});
    if (queueItemPendingQueuing) {
      logger.silly('Mongo queue item found');
      // Work with queueItem
      const {correlationId, operation, contentType} = queueItemPendingQueuing;
      logger.silly(`Correlation id: ${correlationId}`);
      // Set Mongo job state
      await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.VALIDATOR.QUEUING_IN_PROGRESS});

      try {
        // Get stream from content
        const stream = await mongoOperator.getStream(correlationId);
        const validateRecords = true;

        // Read stream to MarcRecords and send em to queue
        // This is a promise that resolves when all the records are in queue and rejects if any of the records in the stream fail
        await toMarcRecords.streamToRecords({correlationId, headers: {operation, cataloger: queueItemPendingQueuing.cataloger}, contentType, stream, validateRecords});

        // If we'd like to validate/match/merge bulk job records it could be done here

        // Set Mongo job state
        // This should setState to VALIDATOR.PENDING_VALIDATION if we're validationg bulk jobs

        const newState = validateRecords ? QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION : QUEUE_ITEM_STATE.IMPORTER.IN_QUEUE;

        await mongoOperator.setState({correlationId, state: newState});

      } catch (error) {
        if (error instanceof ApiError) {
          logger.verbose(`validator/app/checkMongo errored ${JSON.stringify(error)} in ${correlationId}`);
          await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.ERROR, errorMessage: error.payload, errorStatus: error.status});

          return initCheck();
        }
        logError(error);
        throw error;
      }

      return initCheck();
    }

    // No job found
    return initCheck(true);
  }

}

