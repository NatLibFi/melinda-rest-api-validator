import deepEqual from 'deep-eql';
import HttpStatus from 'http-status';
import {isArray} from 'util';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import {Error as ValidationError, Utils, RecordMatching, OwnAuthorization} from '@natlibfi/melinda-commons';
import {validations, conversions, OPERATIONS} from '@natlibfi/melinda-rest-api-commons';
import createSruClient from '@natlibfi/sru-client';
import {SRU_URL_BIB} from '../config';
import {updateField001ToParamId} from '../utils';

const {createLogger} = Utils;

export default async function () {
	const logger = createLogger();
	const ValidationService = await validations();
	const ConversionService = conversions();
	const RecordMatchingService = RecordMatching.createBibService({sruURL: SRU_URL_BIB});
	const sruClient = createSruClient({serverUrl: SRU_URL_BIB, version: '2.0', maximumRecords: '1'});

	return {process};

	async function process(headers, data) {
		const {
			operation,
			format,
			cataloger,
			noop
		} = headers;
		const id = headers.id || undefined;
		const unique = headers.unique || undefined;

		logger.log('debug', 'Unserializing record');
		let record = ConversionService.unserialize(data, format);

		logger.log('debug', 'Validating the record');
		const result = await executeValidations();

		if (noop) {
			return result;
		}

		return {headers: {operation, cataloger: cataloger.id}, data: result.toObject()};

		async function executeValidations() {
			if (operation === OPERATIONS.UPDATE) {
				return updateValidations();
			}

			return createValidations();
		}

		async function updateValidations() {
			if (id) {
				const updatedRecord = updateField001ToParamId(`${id}`, record);
				logger.log('debug', `Reading record ${id} from SRU`);
				const existingRecord = await getRecord(id);
				logger.log('debug', 'Checking LOW-tag authorization');
				await OwnAuthorization.validateChanges(cataloger.authorization, updatedRecord, existingRecord);
				logger.log('debug', 'Checking CAT field history');
				validateRecordState(updatedRecord, existingRecord);

				if (noop) {
					return ValidationService.validate(updatedRecord);
				}

				return updatedRecord;
			}

			throw new ValidationError(HttpStatus.BAD_REQUEST, 'Update id missing!');
		}

		async function createValidations() {
			const updatedRecord = updateField001ToParamId('1', record);
			logger.log('debug', 'Checking LOW-tag authorization');
			await OwnAuthorization.validateChanges(cataloger.authorization, updatedRecord);

			if (unique) {
				logger.log('debug', 'Attempting to find matching records in the SRU');
				const matchingIds = await RecordMatchingService.find(updatedRecord);

				if (matchingIds.length > 0) {
					throw new ValidationError(HttpStatus.CONFLICT, matchingIds);
				}

				if (noop) {
					return ValidationService.validate(updatedRecord);
				}

				return updatedRecord;
			}

			if (noop) {
				return ValidationService.validate(updatedRecord);
			}

			return updatedRecord;
		}
	}

	// Checks that the modification history is identical
	function validateRecordState(incomingRecord, existingRecord) {
		const incomingModificationHistory = (isArray(incomingRecord)) ? incomingRecord : incomingRecord.get(/^CAT$/);
		const existingModificationHistory = existingRecord.get(/^CAT$/);

		if (deepEqual(incomingModificationHistory, existingModificationHistory) === false) {
			throw new ValidationError(HttpStatus.CONFLICT, 'Modification history mismatch (CAT)');
		}
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
}
