import {toAlephId, getRecordTitle, getRecordStandardIdentifiers} from '@natlibfi/melinda-commons';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import httpStatus from 'http-status';

const logger = createLogger();

export function updateField001ToParamId(id, record) {
  logger.silly(`Updating F001 value to ${id}`);
  const fields = record.get(/^001$/u);

  if (fields.length === 0) {
    // Return to break out of function
    record.insertField({tag: '001', value: toAlephId(id)});
    return record;
  }

  fields[0].value = toAlephId(id); // eslint-disable-line functional/immutable-data

  return record;
}

//

export function getRecordMetadata(record, number) {
  const sourceId = record ? getIncomingIdFromRecord(record) : undefined;
  const title = record ? getRecordTitle(record) : undefined;
  const standardIdentifiers = record ? getRecordStandardIdentifiers(record) : undefined;
  const blobSequence = number || '1';
  return {sourceId, blobSequence, title, standardIdentifiers};
}


// This should find also SIDs & standard identifiers

export function getIncomingIdFromRecord(record) {
  const [f003] = record.get(/^003$/u);
  const [f001] = record.get(/^001$/u);

  if (f003 && f001) {
    return `(${f003.value})${f001.value}`;
  }

  if (f001) {
    return `${f001.value}`;
  }

  return undefined;

}

export function getIdFromRecord(record) {
  const [f001] = record.get(/^001$/u);

  if (f001) {
    return `${f001.value}`;
  }

  return undefined;

}


export function createRecordResponseItem({responsePayload, responseStatus, recordMetadata, id}) {
  const recordResponseStatus = getRecordResponseStatus(responseStatus, responsePayload);
  const recordResponseItem = {
    melindaId: id || undefined,
    recordMetadata: recordMetadata || undefined,
    ...recordResponseStatus
  };
  return recordResponseItem;
}

export function getRecordResponseStatus(responseStatus, responsePayload) {

  logger.verbose(`Response status: ${responseStatus} responsePayload: ${JSON.stringify(responsePayload)}`);
  const responseStatusName = httpStatus[`${responseStatus}_NAME`];
  logger.verbose(`Response status name: ${responseStatusName}`);

  // Non-http statuses
  if (['UPDATED', 'CREATED', 'INVALID', 'ERROR', 'UNKNOWN'].includes(responseStatus)) {
    return {status: responseStatus, message: responsePayload};
  }

  // Duplicates and other conflicts
  if ([httpStatus.CONFLICT, 'CONFLICT'].includes(responseStatus)) {
    if (responsePayload.message && (/^Duplicates in database/u).test(responsePayload.message)) {
      return {status: 'DUPLICATE', message: responsePayload.message, ids: responsePayload.ids};
    }
    return {status: 'CONFLICT', message: responsePayload.message};
  }

  if ([httpStatus.UNPROCESSABLE_ENTITY, 'UNPROCESSABLE_ENTITY'].includes(responseStatus)) {
    return {status: 'UNPROCESSABLE_ENTITY', message: responsePayload};
  }

  if ([httpStatus.NOT_FOUND, 'NOT_FOUND'].includes(responseStatus)) {
    return {status: 'NOT_FOUND', message: responsePayload};
  }

  return {status: 'ERROR', message: responsePayload};
}

export async function addRecordResponseItem({recordResponseItem, correlationId, mongoOperator}) {
  await mongoOperator.pushMessages({correlationId, messages: [recordResponseItem], messageField: 'records'});
  return true;
}
