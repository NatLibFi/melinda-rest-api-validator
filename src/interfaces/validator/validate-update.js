
import createDebugLogger from 'debug';
//import {MarcRecord} from '@natlibfi/marc-record';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:validate-update');
const debugData = debug.extend('data');

// Note: when we get new recordImport catalogers or imported conversions, these need to be updated
// These could also exist as env-configs
const catalogerToConversionNameMapping = {
  'IMP_HELMET': 'Helmet to Melinda MARC transformation',
  'IMP_TATI': 'TATI to Melinda MARC transformation',
  'IMP_ENNAKK': 'ONIX3 to MARC transformation',
  'IMP_VPKPL': 'ONIX3 to MARC transformation'
};

// eslint-disable-next-line max-statements
export function validateUpdate({incomingRecord, existingRecord, cataloger, validate = true}) {

  if (validate === false) {
    debug(`Skipping validateUpdate. Validate: ${validate}`);
    return {updateValidationResult: 'skipped'};
  }

  const actualCataloger = cataloger && cataloger.id ? cataloger.id : cataloger;
  debug(`Found cataloger ${actualCataloger} from ${JSON.stringify(cataloger)}`);

  if (!actualCataloger || !Object.keys(catalogerToConversionNameMapping).includes(actualCataloger)) {
    debug(`No cataloger or cataloger ${actualCataloger} not included in those who need updateValidation`);
    return {updateValidationResult: true};
  }

  const incomingF884 = incomingRecord.get(/^884$/u);
  const existingF884 = existingRecord.get(/^884$/u);

  debugData(`Incoming f884: ${JSON.stringify(incomingF884)}`);
  debugData(`Existing f884: ${JSON.stringify(existingF884)}`);

  if (incomingF884.length < 1 || existingF884.length < 1) {
    debug(`No incoming (${incomingF884.length}) or existing (${existingF884.length}) f884s to do update validation`);
    return {updateValidationResult: true};
  }

  const conversionName = catalogerToConversionNameMapping[actualCataloger];

  debug(`Searching for fields with $a: "${conversionName}"`);
  const incomingSourceHashes = getSourceHashes(incomingF884, conversionName);
  const existingSourceHashes = getSourceHashes(existingF884, conversionName);

  if (incomingSourceHashes.length < 1 || existingSourceHashes.length < 1) {
    debug(`No incoming (${incomingSourceHashes.length}) or existing (${existingSourceHashes.length}) sourceHashes found to do update validation`);
    return {updateValidationResult: true};
  }

  if (incomingSourceHashes.some(sh => existingSourceHashes.indexOf(sh) !== -1)) {
    debug(`We have an incoming sourceHash that matches existing sourceHash: no need to update!`);
    return {updateValidationResult: false};
  }
  debug(`No matching sourceHashes`);

  return {updateValidationResult: true};
}

function getSourceHashes(fields, conversionName) {
  // we want sf $k from those fields that have sf $a that matches the conversion name
  const matchingFields = fields.filter((field) => field.subfields && field.subfields.some((subfield) => subfield.code === 'a' && subfield.value === conversionName));
  debugData(`We have (${matchingFields.length}) fields with $a matching "${conversionName}"`);
  debugData(`${JSON.stringify(matchingFields)}`);

  const sourceHashes = matchingFields.map((field) => field.subfields
    .filter(({code}) => ['k'].includes(code))
    .filter(value => value)
    .map(({value}) => String(value))
    // check that $k actually has a hash (length 64), not just RECORD_IMPORT_SOURCE
    .filter(value => value && value.length > 63));

  const flattenedSourceHashes = sourceHashes.flat();
  debugData(`We have ${JSON.stringify(flattenedSourceHashes)}`);

  return flattenedSourceHashes;
}
