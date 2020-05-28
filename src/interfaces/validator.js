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
  const validationService = await validations();
  const ConversionService = conversions();
  const RecordMatchingService = RecordMatching.createBibService({sruURL: sruUrlBib});
  const sruClient = createSruClient({serverUrl: sruUrlBib, version: '2.0', maximumRecords: '1'});

  return {process};

  async function process(headers, data) {
    logger.log('debug', `process headers ${JSON.stringify(headers)}`);
    const {
      operation,
      format,
      cataloger,
      noop
    } = headers;
    const id = headers.id || undefined;
    const unique = headers.unique || undefined;

    const record = ConversionService.unserialize(data, format);

    logger.log('silly', `Unserialize record:\n${JSON.stringify(record)}`);

    if (noop) {
      const result = {
        status: operation === 'CREATE' ? 'CREATED' : 'UPDATED',
        ...await executeValidations()
      };
      return result;
    }
    const result = await executeValidations();

    if (result.failed) { // eslint-disable-line functional/no-conditional-statement
      logger.log('debug', 'Validation failed');
      throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, result.messages);
    }

    return {headers: {operation, cataloger: cataloger.id}, data: result.record.toObject()};

    function executeValidations() {
      logger.log('verbose', 'Validating the record');

      if (operation === OPERATIONS.UPDATE) {
        return updateValidations();
      }

      return createValidations();
    }

    async function updateValidations() {
      logger.log('verbose', 'Validations for UPDATE operation');
      if (id) {
        const updatedRecord = updateField001ToParamId(`${id}`, record);
        logger.log('silly', `Updated record:\n${JSON.stringify(updatedRecord)}`);

        logger.log('verbose', `Reading record ${id} from SRU`);
        const existingRecord = await getRecord(id);

        logger.log('verbose', 'Checking LOW-tag authorization');
        await OwnAuthorization.validateChanges(cataloger.authorization, updatedRecord, existingRecord);

        logger.log('verbose', 'Checking CAT field history');
        validateRecordState(updatedRecord, existingRecord);

        const validationResults = await validationService(updatedRecord);
        return validationResults;
      }

      logger.log('debug', 'No id in headers');
      throw new ValidationError(HttpStatus.BAD_REQUEST, 'Update id missing!');
    }

    async function createValidations() {
      logger.log('verbose', 'Validations for CREATE operation');
      const updatedRecord = updateField001ToParamId('1', record);
      logger.log('silly', `Updated record:\n${JSON.stringify(updatedRecord)}`);

      logger.log('verbose', 'Checking LOW-tag authorization');
      await OwnAuthorization.validateChanges(cataloger.authorization, updatedRecord);

      if (unique) {
        logger.log('verbose', 'Attempting to find matching records in the SRU');
        const matchingIds = await RecordMatchingService.find(updatedRecord);

        if (matchingIds.length > 0) { // eslint-disable-line functional/no-conditional-statement
          logger.log('debug', 'Matching record has been found');
          throw new ValidationError(HttpStatus.CONFLICT, matchingIds);
        }

        const validationResults = await validationService(updatedRecord);
        return validationResults;
      }

      const validationResults = await validationService(updatedRecord);
      return validationResults;
    }
  }

  // Checks that the modification history is identical
  function validateRecordState(incomingRecord, existingRecord) {
    const incomingModificationHistory = isArray(incomingRecord) ? incomingRecord : incomingRecord.get(/^CAT$/u);
    const existingModificationHistory = existingRecord.get(/^CAT$/u);

    // Merge makes uuid variables to all fields and this removes those
    const incomingModificationHistoryNoUuids = incomingModificationHistory.map(field => { // eslint-disable-line arrow-body-style
      return {tag: field.tag, ind1: field.ind1, ind2: field.ind2, subfields: field.subfields};
    });

    logger.log('silly', `Incoming CATS:\n${JSON.stringify(incomingModificationHistoryNoUuids)}`);
    logger.log('silly', `Existing CATS:\n${JSON.stringify(existingModificationHistory)}`);
    if (deepEqual(incomingModificationHistoryNoUuids, existingModificationHistory) === false) { // eslint-disable-line functional/no-conditional-statement
      throw new ValidationError(HttpStatus.CONFLICT, 'Modification history mismatch (CAT)');
    }

    // Check if existing record is deleted
    const staDeletedFields = existingRecord.getFields('STA', [{code: 'a', value: 'DELETED'}]);

    if (staDeletedFields.length > 0) { // eslint-disable-line functional/no-conditional-statement
      logger.log('debug', 'Record is deleted');
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
