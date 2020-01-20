/* eslint-disable no-unused-vars, no-warning-comments */
import amqplib from 'amqplib';
import {Utils} from '@natlibfi/melinda-commons';
import {PRIO_IMPORT_QUEUES} from '@natlibfi/melinda-record-import-commons';
import validatorFactory from './validator';
import {AMQP_URL, POLL_WAIT_TIME} from '../config';
import {logError} from '../utils';
import {promisify} from 'util';

const setTimeoutPromise = promisify(setTimeout);
const {createLogger} = Utils;

export default async function () {
	const {REQUESTS} = PRIO_IMPORT_QUEUES;
	const logger = createLogger(); // eslint-disable-line no-unused-vars
	const connection = await amqplib.connect(AMQP_URL);
	const channel = await connection.createChannel();
	const validator = await validatorFactory();

	return {checkQueue, pushToQueue, clearQeueu};

	async function checkQueue(init = false, purge = false) {
		if (init) {
			channel.assertQueue(REQUESTS);
		}

		if (purge) {
			channel.purgeQueue(REQUESTS);
		}

		const channelInfo = await channel.checkQueue(REQUESTS);
		logger.log('debug', `${REQUESTS} queue: ${channelInfo.messageCount} messages`);
		if (channelInfo.messageCount < 1) {
			await setTimeoutPromise(POLL_WAIT_TIME);
			return checkQueue();
		}

		consume();
	}

	async function consume() {
		try {
			const queData = await channel.get(REQUESTS);

			if (queData) {
				const correlationId = queData.properties.correlationId;
				const content = JSON.parse(queData.content.toString());

				// Logger.log('debug', `Reading request: ${correlationId}, ${JSON.stringify(content)}`);

				// Validation: Returns validationResults if noop
				const valid = await validator.process(queData.properties.headers, content.data);
				if (queData.properties.headers.noop) {
					// Send validation back to REPLY
					const reply = {
						correlationId,
						catalogger: queData.properties.headers.cataloger,
						operation: queData.properties.headers.operation,
						data: valid
					};
					pushToQueue(reply, 'REPLY');
				}

				// Send to realQueue (pass headers and correlationId)
				valid.correlationId = correlationId;
				const queue = (valid.operation === 'update') ? PRIO_IMPORT_QUEUES.UPDATE : PRIO_IMPORT_QUEUES.CREATE;
				await pushToQueue(valid, queue);

				// Ack message when all done
				channel.ack(queData);
			}

			checkQueue();
		} catch (err) {
			checkQueue(true);
			throw err;
		}
	}

	// Data: record, validationResults or error
	async function pushToQueue({correlationId, cataloger, operation, data}, queue = false) {
		try {
			// Logger.log('debug', `Record queue ${queue}`);
			// logger.log('debug', `Record cataloger ${cataloger}`)
			// logger.log('debug', `Record id ${id}`);
			// logger.log('debug', `Record record ${record}`);
			// logger.log('debug', `Record operation ${operation}`);

			if (queue) {
				// Spams! logger.log('debug', `Handling ${correlationId} to ${queue}`);
				await channel.assertQueue(queue, {durable: true});
				channel.sendToQueue(
					queue,
					Buffer.from(JSON.stringify({data})),
					{
						persistent: true,
						correlationId,
						headers: {
							cataloger,
							operation
						}
					}
				);
			} else {
				logger.log('debug', `Handling ${correlationId} to Queue`);
				await channel.assertQueue(correlationId, {durable: true});
				channel.sendToQueue(
					correlationId,
					Buffer.from(JSON.stringify({data}),
						{
							persistent: true,
							correlationId,
							headers: {
								cataloger,
								operation
							}
						})
				);
			}
		} catch (err) {
			logError(err);
		}
	}

	async function clearQeueu(queue) {
		logger.log('info', `Clearing queue ${queue}`);
		try {
			await channel.deleteQueue(queue);
		} catch (err) {
			logError(err);
		}
	}
}
