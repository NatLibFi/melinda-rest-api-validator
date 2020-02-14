import {Json, MARCXML, AlephSequential, ISO2709} from '@natlibfi/marc-record-serializers';
import {Utils} from '@natlibfi/melinda-commons';
import {amqpFactory, OPERATIONS} from '@natlibfi/melinda-rest-api-commons';
import {AMQP_URL} from '../config';
import {updateField001ToParamId} from '../utils';

const {createLogger} = Utils;

export async function streamToMarcRecords({correlationId, headers, stream}) {
	const {operation, contentType} = headers;
	const logger = createLogger();
	const amqpOperator = await amqpFactory(AMQP_URL);
	let recordNumber = 0;
	let promises = [];
	const reader = chooseAndInitReader();

	// Purge queue before importing records in
	await amqpOperator.checkQueue(correlationId, 'messages', true);

	await new Promise((resolve, reject) => {
		reader.on('error', err => {
			reject(err);
		}).on('data', data => {
			promises.push(transform(data));

			async function transform(record) {
				recordNumber++;
				// Operation CREATE -> f001 new value
				if (operation === OPERATIONS.CREATE) {
					// Field 001 value -> 000000000, 000000001, 000000002....
					record = updateField001ToParamId(`${recordNumber}`, record);

					await amqpOperator.sendToQueue({queue: correlationId, correlationId, headers, data: record.toObject()});

					return;
				}

				await amqpOperator.sendToQueue({queue: correlationId, correlationId, headers, data: record.toObject()});
			}
		}).on('error', data => {
			reject(data);
		}).on('end', async () => {
			logger.log('debug', `Read ${promises.length} records from stream`);
			await Promise.all(promises);
			logger.log('info', 'Request handling done!');
			resolve();
		});
	});

	function chooseAndInitReader() {
		if (contentType === 'application/alephseq') {
			return new AlephSequential.Reader(stream);
		}

		if (contentType === 'application/json') {
			return new Json.Reader(stream);
		}

		if (contentType === 'application/xml') {
			return new MARCXML.Reader(stream);
		}

		if (contentType === 'application/marc') {
			return new ISO2709.Reader(stream);
		}
	}
}
