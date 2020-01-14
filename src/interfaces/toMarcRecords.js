import {Json, MARCXML, AlephSequential, ISO2709} from '@natlibfi/marc-record-serializers';
import {logError} from '../utils';
import {Utils} from '@natlibfi/melinda-commons';

const {createLogger, toAlephId} = Utils;

export async function streamToMarcRecords(contentType, stream, operation) {
	const logger = createLogger();
	let records = [];
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

	await new Promise((res, rej) => {
		reader.on('data', record => {
			promises.push(transform(record));
			async function transform(value) {
				// Operation Create -> f001 new value
				if (operation.toLowerCase() === 'create') {
					// Field 001 value -> 000000000, 000000001, 000000002....
					updateField001ToParamId(`${records.length + 1}`, value);
				}

				records.push(value.toObject());
			}
		}).on('end', async () => {
			logger.log('debug', `Readed ${promises.length} records from stream`);
			await Promise.all(promises);
			logger.log('info', 'Request handling done!');
			res();
		}).on('error', err => {
			logError(err);
			rej(err);
		});
	});

	return records;
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
