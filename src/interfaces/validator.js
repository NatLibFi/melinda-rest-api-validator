import {MARCXML} from '@natlibfi/marc-record-serializers';
import ValidationError, {Utils, RecordMatching, OwnAuthorization} from '@natlibfi/melinda-commons';
import createSruClient from '@natlibfi/sru-client';
import HttpStatus from 'http-status';
import deepEqual from 'deep-eql';
import {isArray} from 'util';
import {SRU_URL_BIB, SRU_URL_BIBPRV} from '../config';
import createValidationService from '../helppers/validation';
import createConversionService from '../helppers/conversion';

const {createLogger, toAlephId} = Utils;

export default async function () {
	const logger = createLogger();
	const ValidationService = await createValidationService();
	const ConversionService = createConversionService();
	const RecordMatchingService = RecordMatching.createBibService({SRU_URL_BIB});
	const sruClient = createSruClient({serverUrl: SRU_URL_BIBPRV, version: '2.0', maximumRecords: '1'});

	return {process};

	async function process(headers, data) {
		// TODO: Error handling!

		const {
			operation,
			format,
			cataloger,
			noop
		} = headers;
		const id = headers.id || undefined;
		const unique = headers.unique || undefined;

		logger.log('debug', 'Unserializing record');
		const record = ConversionService.unserialize(data, format);

		if (operation === 'update' && id) {
			logger.log('debug', `Reading record ${id} from datastore`);
			const existingRecord = await getRecord(id);
			logger.log('debug', 'Checking LOW-tag authorization');
			OwnAuthorization.validateChanges(cataloger.authorization, record, existingRecord);
			validateRecordState(record, existingRecord);
		} else {
			logger.log('debug', 'Checking LOW-tag authorization');
			OwnAuthorization.validateChanges(cataloger.authorization, record);
		}

		if (unique) {
			logger.log('debug', 'Attempting to find matching records in the datastore');
			const matchingIds = await RecordMatchingService.find(record);

			if (matchingIds.length > 0) {
				throw new ValidationError(HttpStatus.CONFLICT, matchingIds);
			}
		}

		logger.log('debug', 'Validating the record');
		const validationResults = await ValidationService.validate(record);

		if (noop) {
			return validationResults;
		}

		if (operation === 'update') {
			updateField001ToParamId(id, record);
		} else {
			updateField001ToParamId('1', record);
		}

		return {operation, cataloger: cataloger.id, data: record.toObject()};
	}

	// Checks that the modification history is identical
	function validateRecordState(incomingRecord, existingRecord) {
		let incomingModificationHistory;
		if (isArray(incomingRecord)) {
			incomingModificationHistory = incomingRecord;
		} else {
			incomingModificationHistory = incomingRecord.get(/^CAT$/);
		}

		const existingModificationHistory = existingRecord.get(/^CAT$/);
		if (!deepEqual(incomingModificationHistory, existingModificationHistory)) {
			return false;
		}

		return true;
	}

	async function getRecord(id) {
		let record;
		await new Promise((resolve, reject) => {
			sruClient.searchRetrieve(`rec.id=${id}`)
				.on('record', xmlString => {
					record = MARCXML.from(xmlString);
				})
				.on('end', () => resolve())
				.on('error', err => reject(err));
		});

		return record;
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
}
