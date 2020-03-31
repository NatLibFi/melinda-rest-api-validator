import {promisify} from 'util';
import {Error as ApiError, Utils} from '@natlibfi/melinda-commons';
import {mongoFactory, amqpFactory, logError, QUEUE_ITEM_STATE} from '@natlibfi/melinda-rest-api-commons';
import {POLL_REQUEST, POLL_WAIT_TIME, AMQP_URL, MONGO_URI} from './config';
import validatorFactory from './interfaces/validator';
import toMarcRecordFactory from './interfaces/toMarcRecords';

const {createLogger} = Utils;
const setTimeoutPromise = promisify(setTimeout);

run();

async function run() {
  const logger = createLogger(); // eslint-disable-line no-unused-vars
  const mongoOperator = await mongoFactory(MONGO_URI);
  const amqpOperator = await amqpFactory(AMQP_URL);
  const validator = await validatorFactory();
  const toMarcRecords = await toMarcRecordFactory(amqpOperator);

  logger.log('info', `Started Melinda-rest-api-validator: ${POLL_REQUEST ? 'PRIORITY' : 'BULK'}`);

  try {
    check();
  } catch (error) {
    logError(error);
    process.exit(1); // eslint-disable-line no-process-exit
  }

  // Loop
  async function check(wait) {
    if (wait) {
      await setTimeoutPromise(POLL_WAIT_TIME);
      return check(false);
    }

    if (POLL_REQUEST) {
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

        return check();
      }

      // No job found
      return check(true);
    } catch (error) {
      logError(error);
      await amqpOperator.ackNReplyMessages({
        status: error.status || 500,
        messages: [message],
        payloads: [error.payload]
      });
      return check(true);
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
          return check();
        }

        throw error;
      }

      return check();
    }

    // No job found
    return check(true);
  }
}
