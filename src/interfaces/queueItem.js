/* eslint-disable no-unused-vars */

import {MongoClient, GridFSBucket} from 'mongodb';
import DatabaseError, {Utils} from '@natlibfi/melinda-commons';
import {MONGO_URI} from '../config';
import {streamToMarcRecords} from './toMarcRecords';
import {logError} from '../utils';

const {createLogger} = Utils;

/* QueueItem:
	{
		"id":"test",
		"cataloger":"xxx0000",
		"operation":"update",
		"contentType":"application/json",
		"queueItemState":"PENDING_QUEUING",
		"creationTime":"2020-01-01T00:00:00.000Z",
		"modificationTime":"2020-01-01T00:00:01.000Z"
	}
*/

export default function () {
	const logger = createLogger(); // eslint-disable-line no-unused-vars

	return {checkDB};

	async function checkDB() {
		let client;
		let result;
		try {
			// Connect to mongo (MONGO)
			client = await MongoClient.connect(MONGO_URI, {useNewUrlParser: true, useUnifiedTopology: true});
			const db = client.db('rest-api');
			// Check mongo if any QUEUE_ITEM_STATE.PENDING_QUEUING (MONGO)
			result = await db.collection('queue-items').findOne({queueItemState: 'PENDING_QUEUING'});
		} catch (error) {
			logError(error);
		} finally {
			client.close();
			if (result === null) {
				logger.log('debug', 'No Pending queue items found!');
				setTimeout(checkDB, 3000);
			} else {
				// Read content (MONGO)
				readContentToMarcRecords(result);
			}
		}
	}

	// Transform content to MarcRecords (SERIALIZERS)
	async function readContentToMarcRecords({id, contentType, operation}) {
		let client;
		try {
			client = await MongoClient.connect(MONGO_URI, {useNewUrlParser: true, useUnifiedTopology: true});
			const db = client.db('rest-api');

			const gridFSBucket = new GridFSBucket(db, {bucketName: 'queueItems'});
			// Check that content is there
			await getFileMetadata({gridFSBucket, filename: id});
			// TODO: transform gridFSBucket.openDownloadStreamByName(params.id) to MarcRecords
			const records = await streamToMarcRecords(contentType, gridFSBucket.openDownloadStreamByName(id), operation);
			console.log(records.length);
		} catch (error) {
			logError(error);
		} finally {
			client.close();
			checkDB();
		}
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
