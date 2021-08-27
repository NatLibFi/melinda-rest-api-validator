/* eslint-disable max-statements */
import {promisify} from 'util';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ApiError} from '@natlibfi/melinda-commons';
import {mongoFactory, amqpFactory, logError, QUEUE_ITEM_STATE} from '@natlibfi/melinda-rest-api-commons';
import validatorFactory from './interfaces/validator';
import toMarcRecordFactory from './interfaces/toMarcRecords';
import httpStatus from 'http-status';

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

  logger.log('info', `Started Melinda-rest-api-validator: ${pollRequest ? 'PRIORITY' : 'BULK'}`);

  const server = await initCheck();

  return server;

  // Loop
  async function initCheck(wait = false) {
    if (wait) {
      await setTimeoutPromise(pollWaitTime);
      return initCheck();
    }
    logger.log('silly', 'Initiating check');

    if (pollRequest) {
      return checkAmqp();
    }

    return checkMongo();
  }

  // Check amqp for jobs
  async function checkAmqp() {
    logger.log('silly', 'Checking amqp');
    const message = await amqpOperator.checkQueue('REQUESTS', 'raw', false);
    try {
      if (message) {
        // logger.log('debug', `app/chechAmqp: Found message: ${JSON.stringify(message)}`);
        // Work with message
        const {correlationId} = message.properties;
        logger.log('debug', `app/checkAmqp: correlationId: ${correlationId}`);

        const valid = await mongoOperator.checkAndSetState({correlationId, state: QUEUE_ITEM_STATE.VALIDATOR.VALIDATING});

        if (valid) {
          const {headers} = message.properties;
          const content = JSON.parse(message.content.toString());

          //logger.log('silly', `app/checkAmqp: content ${JSON.stringify(content)}`);

          // Validate data
          //     return {headers: {operation, cataloger: cataloger.id}, data: result.record.toObject()};
          // For Noop operations validation does not return headers

          logger.log('silly', `app/checkAmqp: Actually validating`);
          const processResult = await validator.process(headers, content.data);
          logger.log('silly', `app/checkAmqp: Validation done`);

          // logger.log('debug', `app/checkAmqp: Validation results: ${JSON.stringify(processResult)}`);

          // eslint-disable-next-line functional/no-conditional-statement
          if (processResult.headers !== undefined && processResult.headers.operation !== headers.operation) {
            logger.debug(`Validation changed operation from ${headers.operation} to ${processResult.headers.operation}`);
            await mongoOperator.setOperation({correlationId, operation: processResult.headers.operation});
          }

          // Process validated data
          // Normal data to queue operation.correlationId
          // Noop data to queue correlationId

          const toQueue = {
            correlationId,
            queue: processResult.headers ? `${processResult.headers.operation}.${correlationId}` : correlationId,
            headers: processResult.headers || headers,
            data: processResult.data || processResult
          };

          logger.log('debug', `app/checkAmqp: sending to queue toQueue: ${JSON.stringify(toQueue)}`);
          // Pass processed data forward
          await amqpOperator.sendToQueue(toQueue);
          await amqpOperator.ackMessages([message]);

          if (processResult.headers === undefined) {
            // Noop return returns no headers
            await mongoOperator.checkAndSetState({correlationId, state: QUEUE_ITEM_STATE.DONE});
            return initCheck();
          }

          await mongoOperator.checkAndSetState({correlationId, state: QUEUE_ITEM_STATE.VALIDATOR.IN_QUEUE});
          return initCheck();
        }

        await amqpOperator.ackNReplyMessages({status: httpStatus.REQUEST_TIMEOUT, messages: [message], payloads: ['Time out!']});

        return initCheck();
      }

      // No job found
      return initCheck(true);
    } catch (error) {
      logError(error);
      if (error.status !== 500) {
        await amqpOperator.ackNReplyMessages({
          status: error.status,
          messages: [message],
          payloads: [error.message]
        });
        const {correlationId} = message.properties;
        await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.ERROR, errorMessage: error.payload});
        return initCheck(true);
      }
      await amqpOperator.ackNReplyMessages({
        status: error.status || 500,
        messages: [message],
        payloads: [error.payload || 'Unexpected error!']
      });
      const {correlationId} = message.properties;
      await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.ERROR, errorMessage: 'Internal server error!'});
      return initCheck(true);
    }
  }

  // Check Mongo for jobs
  async function checkMongo() {
    logger.log('silly', 'Checking mongo');
    const queueItem = await mongoOperator.getOne({queueItemState: QUEUE_ITEM_STATE.VALIDATOR.PENDING_QUEUING});
    if (queueItem) {
      logger.log('silly', 'Mongo queue item found');
      // Work with queueItem
      const {correlationId} = queueItem;
      logger.log('silly', `Correlation id: ${correlationId}`);
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
