import deepEqual from 'deep-eql';
import HttpStatus from 'http-status';
import {isArray} from 'util';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import {Error as ValidationError, Utils, RecordMatching, OwnAuthorization} from '@natlibfi/melinda-commons';
import {validations, conversions, OPERATIONS} from '@natlibfi/melinda-rest-api-commons';
import createSruClient from '@natlibfi/sru-client';
import {updateField001ToParamId} from '../utils';

const {createLogger} = Utils;

export default async function (sruUrlBib) {
  const logger = createLogger();
  const ValidationService = await validations();
  const ConversionService = conversions();
  const RecordMatchingService = RecordMatching.createBibService({sruURL: sruUrlBib});
  const sruClient = createSruClient({serverUrl: sruUrlBib, version: '2.0', maximumRecords: '1'});

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
    const record = ConversionService.unserialize(data, format);

    logger.log('debug', 'Validating the record');
    const result = await executeValidations();

    if (noop) {
      return result;
    }

    return {headers: {operation, cataloger: cataloger.id}, data: result.toObject()};

    function executeValidations() {
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

        if (matchingIds.length > 0) { // eslint-disable-line functional/no-conditional-statement
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
    const incomingModificationHistory = isArray(incomingRecord) ? incomingRecord : incomingRecord.get(/^CAT$/u);
    const existingModificationHistory = existingRecord.get(/^CAT$/u);

    if (deepEqual(incomingModificationHistory, existingModificationHistory) === false) { // eslint-disable-line functional/no-conditional-statement
      throw new ValidationError(HttpStatus.CONFLICT, 'Modification history mismatch (CAT)');
    }

    // Check if existing record is deleted
    const staDeletedFields = existingRecord.getFields('STA', [{code: 'a', value: 'DELETED'}]);

    if (staDeletedFields.length > 0) { // eslint-disable-line functional/no-conditional-statement
      throw new ValidationError(HttpStatus.GONE, 'Record is deleted');
    }
  }

  function getRecord(id) {
    return new Promise((resolve, reject) => {
      sruClient.searchRetrieve(`rec.id=${id}`)
        .on('record', xmlString => {
          resolve(MARCXML.from(xmlString));
        })
        .on('end', () => resolve())
        .on('error', err => reject(err));
    });
  }
}
