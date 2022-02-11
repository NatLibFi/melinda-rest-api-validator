import {toAlephId} from '@natlibfi/melinda-commons';
import {createLogger} from '@natlibfi/melinda-backend-commons';

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
