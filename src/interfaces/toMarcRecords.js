import {Json, MARCXML, AlephSequential, ISO2709} from '@natlibfi/marc-record-serializers';
import ConversionError, {Utils} from '@natlibfi/melinda-commons';
import {OPERATIONS, logError} from '@natlibfi/melinda-rest-api-commons';
import {updateField001ToParamId} from '../utils';

export default async function (amqpOperator) {
	const {createLogger} = Utils;
	const logger = createLogger();

	return {streamToRecords};

	async function streamToRecords({correlationId, headers, contentType, stream}) {
		logger.log('info', 'Starting to transform stream to records');
		let recordNumber = 0;
		const promises = [];
		const reader = chooseAndInitReader(contentType);

		// Purge queue before importing records in
		await amqpOperator.checkQueue(correlationId, 'messages', true);

		await new Promise((resolve, reject) => {
			logger.log('info', 'Reading stream to records');
			reader.on('error', err => {
				logError(err);
				reject(new ConversionError(422, 'Invalid payload!'));
			}).on('data', data => {
				promises.push(transform(data, recordNumber));
				recordNumber++;

				if (recordNumber % 100 === 0) {
					logger.log('debug', `Record ${recordNumber} has been red`);
				}

				async function transform(record, number) {
					// Operation CREATE -> f001 new value
					if (headers.operation === OPERATIONS.CREATE) {
						// Field 001 value -> 000000000, 000000001, 000000002....
						const updatedRecord = updateField001ToParamId(`${number}`, record);

						if (number % 100 === 0) {
							logger.log('debug', `record ${number} has been queued`);
						}

						return amqpOperator.sendToQueue({queue: correlationId, correlationId, headers, data: updatedRecord.toObject()});
					}

					await amqpOperator.sendToQueue({queue: correlationId, correlationId, headers, data: record.toObject()});

					if (number % 100 === 0) {
						logger.log('debug', `record ${number} has been queued`);
					}
				}
			}).on('end', async () => {
				logger.log('info', `Red ${promises.length} records from stream`);
				logger.log('info', 'This might take some time!');
				await Promise.all(promises);
				logger.log('info', 'Request handling done!');
				resolve();
			});
		});

		function chooseAndInitReader(contentType) {
			if (contentType === 'application/alephseq') {
				logger.log('info', 'AlephSeq stream!');
				return new AlephSequential.Reader(stream);
			}

			if (contentType === 'application/json') {
				logger.log('info', 'JSON stream!');
				return new Json.Reader(stream);
			}

			if (contentType === 'application/xml') {
				logger.log('info', 'XML stream!');
				return new MARCXML.Reader(stream);
			}

			if (contentType === 'application/marc') {
				logger.log('info', 'MARC stream!');
				return new ISO2709.Reader(stream);
			}

			throw new ConversionError(415, 'Invalid content-type');
		}
	}
}
