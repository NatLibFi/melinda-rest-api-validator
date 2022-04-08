import {toAlephId, getRecordTitle, getRecordStandardIdentifiers} from '@natlibfi/melinda-commons';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import createDebugLogger from 'debug';

const logger = createLogger();
const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:utils');
const debugData = debug.extend('data');

// Should we update 003 here too?
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

export function getRecordMetadata({record, number = undefined, recordMetadata = undefined, getAllSourceIds = false}) {
  if (recordMetadata) {
    const sourceIds = recordMetadata.sourceIds || record ? getSourceIdsFromRecord(record, getAllSourceIds) : undefined;
    const title = recordMetadata.title || record ? getRecordTitle(record) : undefined;
    const standardIdentifiers = recordMetadata.standardIdentifiers || record ? getRecordStandardIdentifiers(record) : undefined;
    const blobSequence = recordMetadata.blobSequence || number || '1';
    return {sourceIds, blobSequence, title, standardIdentifiers};
  }

  const sourceIds = record ? getSourceIdsFromRecord(record, getAllSourceIds) : undefined;
  logger.debug(`sourceIds: ${JSON.stringify(sourceIds)}`);
  const title = record ? getRecordTitle(record) : undefined;
  const standardIdentifiers = record ? getRecordStandardIdentifiers(record) : undefined;
  const blobSequence = number || '1';
  return {sourceIds, blobSequence, title, standardIdentifiers};
}


export function getSourceIdsFromRecord(record, getAllSourceIds = false) {
  const incomingId = getIncomingIdFromRecord(record);
  const f035Ids = getF035IdsFromRecord(record) || [];
  const sids = getSidsFromRecord(record) || [];

  // getAllSource ids returns 003+001/001, 035 $a/$z:s, adn SIDs
  if (getAllSourceIds) {
    const sourceIds = [].concat([incomingId]).concat(f035Ids).concat(sids).filter(value => value);
    const sourceIdsUniq = [...new Set(sourceIds)];
    debug(`Found sourceIds (${sourceIdsUniq.length})`);
    debugData(`SourceIdsUniq: ${JSON.stringify(sourceIdsUniq)}`);
    return sourceIdsUniq.length > 0 ? sourceIdsUniq : [];
  }

  // when not getAllSource ids returns first set of: 003+001/001, 035 $a/$z:s, SIDs
  const chosenSourceIds = chooseSourceIds(incomingId, f035Ids, sids);
  return chosenSourceIds.length > 0 ? chosenSourceIds : [];
}

function chooseSourceIds(incomingId, f035Ids, sids) {
  if (incomingId !== undefined) {
    return [incomingId];
  }

  if (f035Ids && f035Ids.length > 0) {
    return [...new Set(f035Ids)].filter(value => value);
  }

  if (sids && sids.length > 0) {
    return [...new Set(sids)].filter(value => value);
  }
  return [];
}


// This is a version of function used in melinda-record-matching-js:matching-utils
export function getSidsFromRecord(record) {
  const fSIDs = record.get(/^SID$/u);

  return fSIDs.map(toSidSourceId).filter(value => value);

  function toSidSourceId(field) {
    debug(`Getting sourceId string from a field`);

    return validateSidFieldSubfieldCounts(field) ? createSidSourceId(field) : '';

    function createSidSourceId(field) {
      debug(`Creating sourceId string from a field`);
      const [sfC] = getSubfieldValues(field, 'c');
      const [sfB] = getSubfieldValues(field, 'b');

      debugData(`${JSON.stringify(sfC)} + ${JSON.stringify(sfB)}`);
      debugData(`sourceDb: ${sfB}, sourceId: ${sfC} => (${sfB})${sfC}`);
      return `(${sfB})${sfC}`;
    }
  }

  function validateSidFieldSubfieldCounts(field) {
    // Valid SID-fields have just one $c and one $b
    debugData(`Validating SID field ${JSON.stringify(field)}`);
    const countC = countSubfields(field, 'c');
    const countB = countSubfields(field, 'b');
    debug(`Found ${countC} sf $cs and ${countB} sf $bs. IsValid: ${countC === 1 && countB === 1}`);

    return countC === 1 && countB === 1;
  }

  function getSubfieldValues(field, subfieldCode) {
    debugData(`Get subfield(s) $${subfieldCode} from ${JSON.stringify(field)}`);
    return field.subfields.filter(({code}) => code === subfieldCode).map(({value}) => value);
  }

  function countSubfields(field, subfieldCode) {
  // debug(`Counting subfields ${subfieldCode}`);
    return field.subfields.filter(({code}) => code === subfieldCode).length;
  }

}

export function getF035IdsFromRecord(record) {
  const f035s = record.get(/^035$/u);

  const allF035SourceIds = [].concat(...f035s.map(toSourceIds));
  const allIds = [...new Set(allF035SourceIds)];

  debugData(`${JSON.stringify(allF035SourceIds)}`);
  debugData(`${JSON.stringify(allIds)}`);

  return allIds;

  function toSourceIds({subfields}) {
    return subfields
      .filter(sub => ['a', 'z'].includes(sub.code))
      .map(({value}) => value);
  }

}

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

// Should we require that 003 (if existing) is the local 003?
export function getIdFromRecord(record) {
  const [f001] = record.get(/^001$/u);

  if (f001) {
    // if 001 in longer than 9 chars, it's returned as is
    return `${toAlephId(f001.value)}`;
  }

  return undefined;
}
