/* eslint-disable no-unused-vars */

// TODO:
// IF OK ->
//  Change QUEUE_ITEM_STATE.QUEUING (MONGO)
//  Push MarcRecords.toObject()s to queue (AMQPLIB)
//  Do in chunks?
//  Change QUEUE_ITEM_STATE.IN_QUEUE (MONGO)
// IF NOT ->
//  Change QUEUE_ITEM_STATE.ERROR (MONGO)

import {Utils} from '@natlibfi/melinda-commons';
import {logError} from './utils';
import {PRIORITY} from './config';
import {mongoFactory, rabbitFactory} from './interfaces';

const {createLogger} = Utils;

run();

async function run() {
	const logger = createLogger(); // eslint-disable-line no-unused-vars
	const mongoOperator = await mongoFactory();
	const rabbitOperator = await rabbitFactory();

	logger.log('info', 'Started Melinda-rest-api-validator');

	try {
		// Loop
		if (PRIORITY) {
			rabbitOperator.checkQueue(true, false);
		} else {
			mongoOperator.checkDB();
		}
	} catch (error) {
		logError(error);
	}
}
