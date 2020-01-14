/* eslint-disable no-unused-vars */

// TODO:
// IF OK ->
//  Do chunks?
//  Validate MarcRecords (SRU)
//  Change QUEUE_ITEM_STATE.QUEUING (MONGO)
//  Push MarcRecords.toObject()s to queue (AMQPLIB)
//  Do in chunks?
//  Change QUEUE_ITEM_STATE.IN_QUEUE (MONGO)
// IF NOT ->
//  Change QUEUE_ITEM_STATE.ERROR (MONGO)
//
// Check if any QUEUE_ITEM_STATE.IN_QUEUE (MONGO)
// IF all chunks done ->
//  Change QUEUE_ITEM_STATE.DONE (MONGO)

import {Utils} from '@natlibfi/melinda-commons';
import {logError} from './utils';
import {queueItemOperator} from './interfaces';

const {createLogger} = Utils;
run();

async function run() {
	const logger = createLogger(); // eslint-disable-line no-unused-vars
	const queueItem = queueItemOperator();

	logger.log('info', 'Started Melinda-rest-api-validator');

	try {
		// Loop
		queueItem.checkDB();
	} catch (error) {
		logError(error);
	}
}
