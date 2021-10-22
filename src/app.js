/* eslint-disable max-statements */
import {promisify, inspect} from 'util';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {mongoFactory, amqpFactory, logError, QUEUE_ITEM_STATE} from '@natlibfi/melinda-rest-api-commons';
import validatorFactory from './interfaces/validator';
import toMarcRecordFactory from './interfaces/toMarcRecords';

const setTimeoutPromise = promisify(setTimeout);

export default async function ({
  pollRequest, pollWaitTime, amqpUrl, mongoUri, validatorOptions
}) {
  const logger = createLogger();
  const collection = pollRequest ? 'prio' : 'bulk';
  const mongoOperator = await mongoFactory(mongoUri, collection);
  const amqpOperator = await amqpFactory(amqpUrl);
  const validator = await validatorFactory(validatorOptions);
  const toMarcRecords = await toMarcRecordFactory(amqpOperator);

  logger.info(`Started Melinda-rest-api-validator: ${pollRequest ? 'PRIORITY' : 'BULK'}`);

  const server = await initCheck();

  return server;

  // Loop
  async function initCheck(wait = false) {
    if (wait) {
      await setTimeoutPromise(pollWaitTime);
      return initCheck();
    }
    logger.silly('Initiating check');

    // Prio Validator checks requests from amqpQueue REQUESTS
    if (pollRequest) {
      return checkAmqp();
    }

    // Bulk Validator checks Mongo for bulk queueItems in state
    return checkMongo();
  }

  // Check amqp for jobs
  async function checkAmqp() {
    logger.silly('Checking amqp');
    const message = await amqpOperator.checkQueue('REQUESTS', 'raw', false);
    try {
      if (message) {
        // logger.debug(`app/chechAmqp: Found message: ${JSON.stringify(message)}`);
        // Work with message
        const {correlationId} = message.properties;

        logger.silly(`app/checkAmqp: correlationId: ${correlationId}`);

        // checkAndSetState checks that the queueItem is not too old, sets state and return true if okay
        // http did createdPrio in state QUEUE_ITEM_STATE.VALIDATOR.PENDING_VALIDATION
        const valid = await mongoOperator.checkAndSetState({correlationId, state: QUEUE_ITEM_STATE.VALIDATOR.VALIDATING});

        if (valid) {
          const {headers} = message.properties;
          const content = JSON.parse(message.content.toString());

          logger.silly(`app/checkAmqp: content ${inspect(content, {colors: true, maxArrayLength: 3, depth: 1})}}`);
          // validator.process returns:
          //     no-noop: {headers: {operation, cataloger: cataloger.id}, data: result.record.toObject()};
          //     noop:    {status, record, failed, messages} - no headers!

          logger.silly(`app/checkAmqp: Actually validating`);
          const processResult = await validator.process(headers, content.data);
          // If not-noop and validator.process fails, it errors
          // for noop failing marc-record-validate return result.failed: true
          logger.debug(`app/checkAmqp: Validation successfully done`);
          logger.silly(`app/checkAmqp: Validation process results: ${inspect(processResult, {colors: true, maxArrayLength: 3, depth: 1})}`);
          logger.silly(`app/checkAmqp: Validation process results: ${JSON.stringify(processResult)}`);

          // Process validated data

          // noops are DONE here
          const {noop} = headers;
          logger.debug(`app/checkAmqp: noop ${noop}`);

          if (noop) {
            const validationMessage = {status: processResult.status, failed: processResult.failed, messages: processResult.messages};
            logger.debug(`${JSON.stringify(validationMessage)}`);

            await amqpOperator.ackMessages([message]);
            await mongoOperator.pushMessages({correlationId, messageField: 'noopValidationMessages', messages: [validationMessage]});
            await mongoOperator.checkAndSetState({correlationId, state: QUEUE_ITEM_STATE.DONE});
            return initCheck();
          }

          /* Validator could change the operation type
          // eslint-disable-next-line functional/no-conditional-statement
          if (processResult.headers !== undefined && processResult.headers.operation !== headers.operation) {
            logger.debug(`Validation changed operation from ${headers.operation} to ${processResult.headers.operation}`);
            // Should note to mongo that operation has been changed
            await mongoOperator.setOperation({correlationId, operation: processResult.headers.operation});
          }
          */

          // Normal (non-noop) data to queue operation.correlationId
          const toQueue = {
            correlationId,
            queue: `${processResult.headers.operation}.${correlationId}`,
            headers: processResult.headers || headers,
            data: processResult.data
          };

          logger.silly(`app/checkAmqp: sending to queue toQueue: ${inspect(toQueue, {colors: true, maxArrayLength: 3, depth: 1})}`);
          await amqpOperator.ackMessages([message]);
          await amqpOperator.sendToQueue(toQueue);
          await mongoOperator.checkAndSetState({correlationId, state: QUEUE_ITEM_STATE.VALIDATOR.IN_QUEUE});

          return initCheck();
        }

        // queueItem was too old, queueItem was set to ABORT
        // melinda-rest-api-http does not read responses for ABORT from queue:correlationID, no need to send the there
        await amqpOperator.ackMessages([message]);

        return initCheck();
      }

      // No job found
      return initCheck(true);
    } catch (error) {

      logger.debug(`checkAmqpqueue errored: `);
      logError(error);

      logger.silly(`error.status: ${error.status}`);
      const responseStatus = error.status || '500';
      logger.debug(`responseStatus: ${responseStatus}`);

      logger.silly(`error.message: ${error.message}, error.payload: ${error.payload}`);
      const responsePayload = error.message || error.payload || 'Unexpected error!';
      logger.debug(`responsePayload: ${responsePayload}`);

      await amqpOperator.ackMessages([message]);

      const {correlationId} = message.properties;
      logger.silly(`correlationId: ${correlationId}`);
      await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.ERROR, errorStatus: responseStatus, errorMessage: responsePayload});
      return initCheck(true);

    }
  }

  // Check Mongo for jobs
  async function checkMongo() {
    logger.silly('Checking mongo');
    const queueItem = await mongoOperator.getOne({queueItemState: QUEUE_ITEM_STATE.VALIDATOR.PENDING_QUEUING});
    if (queueItem) {
      logger.silly('Mongo queue item found');
      // Work with queueItem
      const {correlationId} = queueItem;
      logger.silly(`Correlation id: ${correlationId}`);
      try {
        const {operation, contentType} = queueItem;
        // Get stream from content
        const stream = await mongoOperator.getStream(correlationId);

        // Read stream to MarcRecords and send em to queue
        await toMarcRecords.streamToRecords({correlationId, headers: {operation, cataloger: queueItem.cataloger}, contentType, stream});

        // Set Mongo job state
        await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.VALIDATOR.IN_QUEUE});
      } catch (error) {
        if (error instanceof ApiError) {
          logError(error);
          await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.ERROR, errorMessage: error.payload});
          return initCheck();
        }

        throw error;
      }

      return initCheck();
    }

    // No job found
    return initCheck(true);
  }
}
