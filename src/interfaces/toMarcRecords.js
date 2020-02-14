import {Json, MARCXML, AlephSequential, ISO2709} from '@natlibfi/marc-record-serializers';
import ConversionError, {Utils} from '@natlibfi/melinda-commons';
import {amqpFactory, OPERATIONS, logError} from '@natlibfi/melinda-rest-api-commons';
import {AMQP_URL} from '../config';
import {updateField001ToParamId} from '../utils';

const {createLogger} = Utils;

export async function streamToMarcRecords({correlationId, operation, contentType, stream}) {
	const logger = createLogger();
	let recordNumber = 0;
	let promises = [];
	const reader = chooseAndInitReader(contentType);
	const amqpOperator = await amqpFactory(AMQP_URL);

	// Purge queue before importing records in
	await amqpOperator.checkQueue(correlationId, 'messages', true);

	await new Promise((resolve, reject) => {
		reader.on('error', err => {
			logError(err);
			reject(new ConversionError(422, 'Invalid payload!'));
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
		}).on('end', async () => {
			logger.log('debug', `Read ${promises.length} records from stream`);
			await Promise.all(promises);
			logger.log('info', 'Request handling done!');
			resolve();
		});
	});

	function chooseAndInitReader(contentType) {
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

		throw new ConversionError(415, 'Invalid content-type');
	}
}
