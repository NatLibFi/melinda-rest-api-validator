import {promisify} from 'util';
import ProcessError, {Utils} from '@natlibfi/melinda-commons';
import {mongoFactory, amqpFactory, logError, QUEUE_ITEM_STATE} from '@natlibfi/melinda-rest-api-commons';
import {POLL_REQUEST, POLL_WAIT_TIME, AMQP_URL, MONGO_URI} from './config';
import validatorFactory from './interfaces/validator';
import toMarcRecordFactory from './interfaces/toMarcRecords';

const {createLogger} = Utils;
const setTimeoutPromise = promisify(setTimeout);

run();

async function run() {
	const logger = createLogger(); // eslint-disable-line no-unused-vars
	let mongoOperator;
	let amqpOperator;
	let validator;
	let toMarcRecords;
	try {
		mongoOperator = await mongoFactory(MONGO_URI);
		amqpOperator = await amqpFactory(AMQP_URL);
		validator = await validatorFactory();
		toMarcRecords = await toMarcRecordFactory(amqpOperator);
	} catch (error) {
		logError(error);
		process.exit(5);
	}

	logger.log('info', `Started Melinda-rest-api-validator: ${(POLL_REQUEST) ? 'PRIORITY' : 'BULK'}`);

	try {
		check();
	} catch (error) {
		logError(error);
		process.exit(5);
	}

	// Loop
	async function check(wait) {
		if (wait) {
			await setTimeoutPromise(POLL_WAIT_TIME);
		}

		if (POLL_REQUEST) {
			return checkAmqp();
		}

		return checkMongo();
	}

	// Check amqp for jobs
	async function checkAmqp() {
		const message = await amqpOperator.checkQueue('REQUESTS', 'raw', false);
		if (message) {
			try {
				// Work with message
				const correlationId = message.properties.correlationId;
				const headers = message.properties.headers;
				const content = JSON.parse(message.content.toString());

				// Validate data
				const valid = await validator.process(headers, content.data);

				// Process validated data
				const toQueue = {
					correlationId,
					queue: (valid.headers === undefined) ? correlationId : headers.operation,
					headers: valid.headers || headers,
					data: valid.data || valid
				};

				// Pass processed data forward
				await amqpOperator.sendToQueue(toQueue);
				await amqpOperator.ackMessages([message]);

				return check();
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

		// No job found
		return check(true);
	}

	// Check Mongo for jobs
	async function checkMongo() {
		let correlationId;
		try {
			const queueItem = await mongoOperator.getOne({queueItemState: QUEUE_ITEM_STATE.PENDING_QUEUING});
			if (queueItem) {
				// Work with queueItem
				const {operation, contentType} = queueItem;
				correlationId = queueItem.correlationId;

				// Get stream from content
				const stream = await mongoOperator.getStream(correlationId);

				// Read stream to MarcRecords and send em to queue
				await toMarcRecords.streamToRecords({correlationId, headers: {operation, cataloger: queueItem.cataloger}, contentType, stream});

				// Set Mongo job state
				await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.IN_QUEUE});
				return check();
			}

			// No job found
			return check(true);
		} catch (error) {
			if (error instanceof ProcessError) {
				logError(error);
				await mongoOperator.setState({correlationId, state: QUEUE_ITEM_STATE.ERROR});
				return check();
			}

			throw error;
		}
	}
}
