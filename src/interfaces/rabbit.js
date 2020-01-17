/* eslint-disable no-unused-vars, no-warning-comments */
import amqplib from 'amqplib';
import {Utils} from '@natlibfi/melinda-commons';
import {PRIO_IMPORT_QUEUES} from '@natlibfi/melinda-record-import-commons';
import validatorFactory from './validator';
import {AMQP_URL} from '../config';
import {logError} from '../utils';

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
			return setTimeout(checkQueue, 1000);
		}

		consume();
	}

	async function consume() {
		try {
			const queData = await channel.get(REQUESTS);

			if (queData) {
				const correlationId = queData.properties.correlationId;
				const content = JSON.parse(queData.content.toString());

				logger.log('debug', `Reading request: ${correlationId}, ${JSON.stringify(content)}`);

				// TODO: Validation
				const valid = await validator.process(queData.properties.headers, content.data);
				// Send to realQueue (pass headers and correlationId)
				valid.id = correlationId;
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

	async function pushToQueue({id, cataloger, operation, record}, queue = false) {
		try {
			// Logger.log('debug', `Record queue ${queue}`);
			// logger.log('debug', `Record cataloger ${cataloger}`)
			// logger.log('debug', `Record id ${id}`);
			// logger.log('debug', `Record record ${record}`);
			// logger.log('debug', `Record operation ${operation}`);

			if (queue) {
				console.log(id);
				await channel.assertQueue(queue, {durable: true});
				channel.sendToQueue(
					queue,
					Buffer.from(JSON.stringify({record})),
					{
						persistent: true,
						correlationId: id,
						headers: {
							cataloger,
							operation
						}
					}
				);
			} else {
				await channel.assertQueue(id, {durable: true});
				channel.sendToQueue(
					id,
					Buffer.from(JSON.stringify({record}),
						{
							persistent: true,
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

	async function clearQeueu(id) {
		logger.log('info', `Clearing queue ${id}`);
		try {
			await channel.deleteQueue(id);
		} catch (err) {
			logError(err);
		}
	}
}
