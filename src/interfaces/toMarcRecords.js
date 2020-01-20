import {Json, MARCXML, AlephSequential, ISO2709} from '@natlibfi/marc-record-serializers';
import {Utils} from '@natlibfi/melinda-commons';
import queueFactory from './rabbit';

const {createLogger, toAlephId} = Utils;

export async function streamToMarcRecords({correlationId, cataloger, contentType, stream, operation}) {
	const logger = createLogger();
	const queueOperator = await queueFactory();
	let recordNumber = 0;
	let promises = [];
	let reader;

	if (contentType === 'application/alephseq') {
		reader = new AlephSequential.Reader(stream);
	}

	if (contentType === 'application/json') {
		reader = new Json.Reader(stream);
	}

	if (contentType === 'application/xml') {
		reader = new MARCXML.Reader(stream);
	}

	if (contentType === 'application/marc') {
		reader = new ISO2709.Reader(stream);
	}

	await new Promise((resolve, reject) => {
		reader.on('error', err => {
			reject(err);
		}).on('data', data => {
			promises.push(transform(data));

			async function transform(record) {
				// Operation Create -> f001 new value
				recordNumber++;
				if (operation === 'create') {
					// Field 001 value -> 000000000, 000000001, 000000002....
					updateField001ToParamId(`${recordNumber}`, record);
				}

				await queueOperator.pushToQueue({correlationId, cataloger, operation, data: record});
			}
		}).on('end', async () => {
			logger.log('debug', `Read ${promises.length} records from stream`);
			await Promise.all(promises);
			logger.log('info', 'Request handling done!');
			resolve();
		});
	});
}

function updateField001ToParamId(id, record) {
	const fields = record.get(/^001$/);

	if (fields.length === 0) {
		// Return to break out of function
		return record.insertField({tag: '001', value: toAlephId(id)});
	}

	fields.map(field => {
		field.value = toAlephId(id);
		return field;
	});
}
