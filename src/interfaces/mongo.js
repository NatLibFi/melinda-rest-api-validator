/* eslint-disable no-unused-vars */

import {MongoClient, GridFSBucket} from 'mongodb';
import DatabaseError, {Utils} from '@natlibfi/melinda-commons';
import {QUEUE_ITEM_STATE} from '@natlibfi/melinda-record-import-commons';
import {MONGO_URI, POLL_WAIT_TIME} from '../config';
import {streamToMarcRecords} from './toMarcRecords';
import {logError} from '../utils';
import moment from 'moment';
import queueFactory from './rabbit';
import {promisify} from 'util';

const {createLogger} = Utils;
const setTimeoutPromise = promisify(setTimeout);

/* QueueItem:
{
	"correlationId":"test",
	"cataloger":"xxx0000",
	"operation":"update",
	"contentType":"application/json",
	"queueItemState":"PENDING_QUEUING",
	"creationTime":"2020-01-01T00:00:00.000Z",
	"modificationTime":"2020-01-01T00:00:01.000Z"
}
*/

export default async function () {
	const logger = createLogger(); // eslint-disable-line no-unused-vars
	const queueOperator = await queueFactory();

	return {checkDB, setState};

	async function checkDB() {
		let client;
		let result;
		logger.log('debug', 'Checking DB');

		try {
			// Connect to mongo (MONGO)
			client = await MongoClient.connect(MONGO_URI, {useNewUrlParser: true, useUnifiedTopology: true});
			const db = client.db('rest-api');
			// Check mongo if any QUEUE_ITEM_STATE.QUEUING_IN_PROGRESS (MONGO) (Job that has not completed)
			result = await db.collection('queue-items').findOne({queueItemState: QUEUE_ITEM_STATE.QUEUING_IN_PROGRESS});
			if (result === null) {
				// Check mongo if any QUEUE_ITEM_STATE.PENDING_QUEUING (MONGO)
				result = await db.collection('queue-items').findOne({queueItemState: QUEUE_ITEM_STATE.PENDING_QUEUING});
			} else {
				// TODO Clear queue and continue to readcontent
				queueOperator.clearQeueu(result.correlationId);
			}
		} catch (error) {
			logError(error);
			await setTimeoutPromise(POLL_WAIT_TIME);
			checkDB();
		} finally {
			client.close();

			if (result === null) {
				// Back to loop
				logger.log('debug', 'No Pending queue items found!');
				await setTimeoutPromise(POLL_WAIT_TIME);
				checkDB();
			} else {
				// Read content (MONGO)
				logger.log('debug', `Result from mongo: ${JSON.stringify(result)}`);
				readContentToMarcRecords(result);
			}
		}
	}

	// Transform content to MarcRecords (MONGO -> SERIALIZERS)
	async function readContentToMarcRecords({correlationId, cataloger, operation, contentType}) {
		let client;
		logger.log('debug', 'Making stream from content');

		// Set queue item state QUEUING_IN_PROGRESS
		await setState({correlationId, cataloger, operation, state: QUEUE_ITEM_STATE.QUEUING_IN_PROGRESS});

		try {
			client = await MongoClient.connect(MONGO_URI, {useNewUrlParser: true, useUnifiedTopology: true});
			const db = client.db('rest-api');
			const gridFSBucket = new GridFSBucket(db, {bucketName: 'queueItems'});

			// Check that content is there
			await getFileMetadata({gridFSBucket, filename: correlationId});

			// Transform gridFSBucket stream to MarcRecords -> to queue
			await streamToMarcRecords({correlationId, cataloger, operation, contentType, stream: gridFSBucket.openDownloadStreamByName(correlationId)});
			// Set queue item state IN_QUEUE
			const result = await setState({correlationId, cataloger, operation, state: QUEUE_ITEM_STATE.IN_QUEUE});
			logger.log('debug', JSON.stringify(result));
		} catch (error) {
			logger.log('error', 'Error while reading content to marcRecords');
			logError(error);

			// Set queue item state ERROR
			await setState({correlationId, cataloger, operation, state: QUEUE_ITEM_STATE.ERROR});
			queueOperator.clearQeueu(correlationId);
		} finally {
			client.close();
			checkDB();
		}
	}

	async function setState({correlationId, cataloger, operation, state}) {
		logger.log('debug', 'Setting queue item state');
		const client = await MongoClient.connect(MONGO_URI, {useNewUrlParser: true});
		const db = client.db('rest-api');
		await db.collection('queue-items').updateOne({
			cataloger,
			correlationId,
			operation
		}, {
			$set: {
				queueItemState: state,
				modificationTime: moment().toDate()
			}
		});
		const result = await db.collection('queue-items').findOne({
			cataloger,
			correlationId,
			operation
		}, {projection: {_id: 0}});
		client.close();
		return result;
	}

	async function getFileMetadata({gridFSBucket, filename}) {
		return new Promise((resolve, reject) => {
			gridFSBucket.find({filename})
				.on('error', reject)
				.on('data', resolve)
				.on('end', () => reject(new DatabaseError(404)));
		});
	}
}
