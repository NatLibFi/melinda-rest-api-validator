import {Utils} from '@natlibfi/melinda-commons';

const {toAlephId, createLogger} = Utils;
const logger = createLogger();

export function updateField001ToParamId(id, record) {
  logger.log('silly', `Updating F001 value to ${id}`);
  const fields = record.get(/^001$/u);

  if (fields.length === 0) {
    // Return to break out of function
    return record.insertField({tag: '001', value: toAlephId(id)});
  }

  fields[0].value = toAlephId(id); // eslint-disable-line functional/immutable-data

  return record;
}
