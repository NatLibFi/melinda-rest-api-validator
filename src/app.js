/* eslint-disable no-unused-vars */

import {promisify} from 'util';
import {Utils} from '@natlibfi/melinda-commons';
import {mongoFactory, amqpFactory, logError, QUEUE_ITEM_STATE} from '@natlibfi/melinda-rest-api-commons';
import {POLL_REQUEST, POLL_WAIT_TIME, AMQP_URL, MONGO_URI} from './config';
import validatorFactory from './interfaces/validator';
import {streamToMarcRecords} from './interfaces/toMarcRecords';

const {createLogger} = Utils;
const setTimeoutPromise = promisify(setTimeout);

run();

async function run() {
	const logger = createLogger(); // eslint-disable-line no-unused-vars
	const mongoOperator = await mongoFactory(MONGO_URI);
	const amqpOperator = await amqpFactory(AMQP_URL);
	const validator = await validatorFactory();

	logger.log('info', 'Started Melinda-rest-api-validator');

	try {
		check();
	} catch (error) {
		logError(error);
	}

	async function check() {
		// Loop
		if (POLL_REQUEST) {
			// Check amqp queue
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
					await amqpOperator.ackNReplyMessages({
						status: error.status || 500,
						messages: [message],
						payloads: [error.payload]
					});
					throw error;
				}
			}
		} else {
			// Check Mongo for jobs
			const result = await mongoOperator.getOne({queueItemState: QUEUE_ITEM_STATE.PENDING_QUEUING});
			if (result) {
				// Work with result
				const {correlationId, cataloger, operation, contentType} = result;

				// Get content as stream
				const stream = await mongoOperator.getStream(correlationId);

				const headers = {
					operation,
					cataloger,
					contentType
				};

				const streamOperation = {
					correlationId,
					headers,
					stream
				};

				// Read stream to MarcRecords and send em to queue
				await streamToMarcRecords(streamOperation);

				// Set Mongo job state
				await mongoOperator.setState({correlationId, headers, state: QUEUE_ITEM_STATE.IN_QUEUE});
				return check();
			}
		}

		// No job found
		await setTimeoutPromise(POLL_WAIT_TIME);
		return check();
	}
}
