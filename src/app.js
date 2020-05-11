import {promisify} from 'util';
import {Error as ApiError, Utils} from '@natlibfi/melinda-commons';
import {mongoFactory, amqpFactory, logError, QUEUE_ITEM_STATE, PRIO_QUEUE_ITEM_STATE} from '@natlibfi/melinda-rest-api-commons';
import validatorFactory from './interfaces/validator';
import toMarcRecordFactory from './interfaces/toMarcRecords';
import httpStatus from 'http-status';

const {createLogger} = Utils;
const setTimeoutPromise = promisify(setTimeout);

export default async function ({
  pollRequest, pollWaitTime, amqpUrl, mongoUri, sruUrlBib
}) {
  const logger = createLogger();
  const mongoOperator = await mongoFactory(mongoUri);
  const amqpOperator = await amqpFactory(amqpUrl);
  const validator = await validatorFactory(sruUrlBib);
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
        // Work with message
        const {correlationId} = message.properties;

        const valid = await mongoOperator.checkAndSetState({correlationId, state: PRIO_QUEUE_ITEM_STATE.VALIDATING});

        if (valid) {
          const {headers} = message.properties;
          const content = JSON.parse(message.content.toString());

          logger.log('silly', JSON.stringify(content));
          // Validate data
          const processResult = await validator.process(headers, content.data);

          // Process validated data
          const toQueue = {
            correlationId,
            queue: processResult.headers === undefined ? correlationId : headers.operation,
            headers: processResult.headers || headers,
            data: processResult.data || processResult
          };

          // Pass processed data forward
          await amqpOperator.sendToQueue(toQueue);
          await amqpOperator.ackMessages([message]);
          if (processResult.headers === undefined) {
            // Noop return
            await mongoOperator.checkAndSetState({correlationId, state: PRIO_QUEUE_ITEM_STATE.DONE});
            return initCheck();
          }

          await mongoOperator.checkAndSetState({correlationId, state: PRIO_QUEUE_ITEM_STATE.VALIDATED});
          return initCheck();
        }

        await amqpOperator.ackNReplyMessages({status: httpStatus.REQUEST_TIMEOUT, messages: [message], payloads: ['Time out!']});

        return initCheck();
      }

      // No job found
      return initCheck(true);
    } catch (error) {
      logError(error);
      if (error.status === 403) {
        await amqpOperator.ackNReplyMessages({
          status: error.status,
          messages: [message],
          payloads: ['LOW tag permission error']
        });
        const {correlationId} = message.properties;
        await mongoOperator.checkAndSetState({correlationId, state: PRIO_QUEUE_ITEM_STATE.ERROR});
        return initCheck(true);
      }
      await amqpOperator.ackNReplyMessages({
        status: error.status || 500,
        messages: [message],
        payloads: [error.payload]
      });
      const {correlationId} = message.properties;
      await mongoOperator.checkAndSetState({correlationId, state: PRIO_QUEUE_ITEM_STATE.ERROR});
      return initCheck(true);
    }
  }

  // Check Mongo for jobs
  async function checkMongo() {
    logger.log('silly', 'Checking mongo');
    const queueItem = await mongoOperator.getOne({queueItemState: QUEUE_ITEM_STATE.PENDING_QUEUING});
    if (queueItem) {
      // Work with queueItem
      const {correlationId} = queueItem;
      try {
        const {operation, contentType} = queueItem;
        // Get stream from content
        const stream = await mongoOperator.getStream(correlationId);

        // Read stream to MarcRecords and send em to queue
        await toMarcRecords.streamToRecords({correlationId, headers: {operation, cataloger: queueItem.cataloger}, contentType, stream});

        // Set Mongo job state
        await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.IN_QUEUE});
      } catch (error) {
        if (error instanceof ApiError) {
          logError(error);
          await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.ERROR});
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
