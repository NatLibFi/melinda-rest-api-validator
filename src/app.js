import {promisify} from 'util';
import {Error as ApiError, Utils} from '@natlibfi/melinda-commons';
import {mongoFactory, amqpFactory, logError, QUEUE_ITEM_STATE} from '@natlibfi/melinda-rest-api-commons';
import validatorFactory from './interfaces/validator';
import toMarcRecordFactory from './interfaces/toMarcRecords';

const {createLogger} = Utils;
const setTimeoutPromise = promisify(setTimeout);

export default async function ({
  pollRequest, pollWaitTime, amqpUrl, mongoUri, sruUrlBib
}) {
  const logger = createLogger(); // eslint-disable-line no-unused-vars
  const mongoOperator = await mongoFactory(mongoUri);
  const amqpOperator = await amqpFactory(amqpUrl);
  const validator = await validatorFactory(sruUrlBib);
  const toMarcRecords = await toMarcRecordFactory(amqpOperator);

  logger.log('info', `Started Melinda-rest-api-validator: ${pollRequest ? 'PRIORITY' : 'BULK'}`);

  const server = await initCheck();

  // Soft shutdown function
  server.on('close', () => {
    logger.log('info', 'Initiating soft shutdown of Melinda-rest-api-validator');
    // Things that need soft shutdown
    // Needs amqp disconnect?
    // Needs mongo disconnect?
  });

  return server;

  // Loop
  async function initCheck(wait) {
    if (wait) {
      await setTimeoutPromise(pollWaitTime);
      return initCheck(false);
    }

    if (pollRequest) {
      return checkAmqp();
    }

    return checkMongo();
  }

  // Check amqp for jobs
  async function checkAmqp() {
    const message = await amqpOperator.checkQueue('REQUESTS', 'raw', false);
    try {
      if (message) {
        // Work with message
        const {correlationId} = message.properties;
        const {headers} = message.properties;
        const content = JSON.parse(message.content.toString());

        // Validate data
        const valid = await validator.process(headers, content.data);

        // Process validated data
        const toQueue = {
          correlationId,
          queue: valid.headers === undefined ? correlationId : headers.operation,
          headers: valid.headers || headers,
          data: valid.data || valid
        };

        // Pass processed data forward
        await amqpOperator.sendToQueue(toQueue);
        await amqpOperator.ackMessages([message]);

        return initCheck();
      }

      // No job found
      return initCheck(true);
    } catch (error) {
      logError(error);
      await amqpOperator.ackNReplyMessages({
        status: error.status || 500,
        messages: [message],
        payloads: [error.payload]
      });
      return initCheck(true);
    }
  }

  // Check Mongo for jobs
  async function checkMongo() {
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
