
import deepEqual from 'deep-eql';
import {detailedDiff} from 'deep-object-diff';
import createDebugLogger from 'debug';
import {normalizeEmptySubfields, getSubfieldValues} from '../../utils';
import {MarcRecord} from '@natlibfi/marc-record';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:validate-changes');
const debugData = debug.extend('data');

// Checks that the incomingRecord and existingRecord are not identical
// eslint-disable-next-line max-statements
export function validateChanges({incomingRecord, existingRecord, validate = true}) {

  if (validate === false) {
    debug(`Skipping validateChanges. Validate: ${validate}`);
    return {changeValidationResult: 'skipped'};
  }

  // Optimize the check by first counting the fields
  const incomingActualFieldTags = incomingRecord.fields.filter(isActualContentField).map(field => field.tag);
  const existingActualFieldTags = existingRecord.fields.filter(isActualContentField).map(field => field.tag);

  if (incomingActualFieldTags.length !== existingActualFieldTags.length) {
    debug(`validateChanges: OK - there are changes between incomingRecord and existingRecord`);
    debugData(`IncomingRecord field count: ${incomingActualFieldTags.length}`);
    debugData(`IncomingRecord field tags: ${incomingActualFieldTags}`);
    debugData(`ExistingRecord field count: ${existingActualFieldTags.length}`);
    debugData(`ExistingRecord field tags: ${existingActualFieldTags}`);
    debugData(`Difference in tags: ${JSON.stringify(detailedDiff(incomingActualFieldTags, existingActualFieldTags))}`);
    return {changeValidationResult: true};
  }

  //debug(`ic`);
  const normIncomingRecord = normalizeRecord(incomingRecord);
  //debug(`db`);
  const normExistingRecord = normalizeRecord(existingRecord);

  if (deepEqual(normIncomingRecord, normExistingRecord) === true) {

    debug(`validateChanges: failure - there are no changes between incomingRecord and existingRecord`);
    debugData(`Differences in records (detailed): ${JSON.stringify(detailedDiff(normExistingRecord, normIncomingRecord), {colors: true, depth: 4})}`);
    debugData(`Incoming record: ${JSON.stringify(incomingRecord)}`);
    debugData(`Existing record: ${JSON.stringify(existingRecord)}`);

    // should we error here or return a result?
    return {changeValidationResult: false};
  }
  debug(`validateChanges: OK - there are changes between incomingRecord and existingRecord`);
  debugData(`Differences in records (detailed): ${JSON.stringify(detailedDiff(normExistingRecord, normIncomingRecord), {colors: true, depth: 4})}`);
  debugData(`Incoming record: ${JSON.stringify(incomingRecord)}`);
  debugData(`Existing record: ${JSON.stringify(existingRecord)}`);

  return {changeValidationResult: true};
}

function isActualContentField(field) {
  // NonContentFields that are ignored when changes are validated
  //'001', '003', '005', '040', '884', 'CAT'
  const nonContentFields = ['001', '003', '005', '040', '884', 'CAT'];

  if (nonContentFields.includes(field.tag)) {
    return false;
  }
  return true;
}

function normalizeRecord(record) {
  debugData(record);
  const normLeader = emptyLeader(record.leader);

  const normControlFields = record.getControlfields().filter(isActualContentField).map(emptyf008);
  //const normControlFields = controlFields.map(emptyf008).filter(isActualContentField);
  //debugData(JSON.stringify(controlFields));

  // normalizeEmptySubfields is an utility function which normalizes all all cases of empty subfield value {code: x, value: ""}, {code: x}, {code: x, value: undefined}  to {value: ""}
  // this is needed, because there are CAT-fields that have empty value in subfield $b
  // we could optimize this step out, if we could be sure that empty subfield values are normalized somewhere else
  const normDataFields = record.getDatafields().filter(isActualContentField).map(normalizeEmptySubfields);

  const normFields = normControlFields.concat(normDataFields);
  // Differences in the (tag) order in Aleph-internal fields are ignored
  // Note that this does not ignore differences in field order inside same tag
  debug(`Sort Aleph internal fields`);
  const sortedNormFields = sortAlephInternalFields(normFields);
  debugData(`OrigTags: ${normFields.map(field => field.tag)}`);
  debugData(`SortTags: ${sortedNormFields.map(field => field.tag)}`);

  //debugData(fields);
  return new MarcRecord({leader: normLeader, fields: sortedNormFields}, {subfieldValues: false});

  function emptyLeader(leader) {
    if (!ldrIsValid(leader)) {
      return leader;
    }
    // emptyLeader:
    // - Normalize away LDR values that are 00-04 and 12-16 which are relevant only in binary MARC 21
    // - Normalize away n/c difference in LDR/05
    const normLeader1 = normalizeLdr05(leader);
    const normLeader2 = emptyLdrBinaryValues(normLeader1);
    return normLeader2;
  }

  function ldrIsValid(leader) {
    if (!typeof leader === 'string' && !(leader instanceof String)) {
      debug(`Non-string LDR, cannot normalize.`);
      return false;
    }
    if (leader.length !== 24) {
      debug(`Weird LDR length, cannot normalize`);
      return false;
    }
    return true;
  }

  function normalizeLdr05(leader) {
    debug(`Normalize LDR/05`);
    const newLeader = `${leader.substring(0, 5)}${normLdr05Value(leader.substring(5, 6))}${leader.substring(6)}`;
    debugData(`LdrOrig: ${leader}`);
    debugData(`LdrNorm: ${newLeader}`);
    return newLeader;
  }

  function normLdr05Value(value) {
    if (value === 'n') {
      return 'c';
    }
    return value;
  }

  function emptyLdrBinaryValues(leader) {
    debug(`Empty LDR binary values`);
    const newLeader = `00000${leader.substring(5, 12)}00000${leader.substring(17)}`;
    debugData(`LdrOrig: ${leader}`);
    debugData(`LdrNorm: ${newLeader}`);
    return newLeader;
  }

  function emptyf008(controlfield) {
    if (controlfield.tag !== '008' || controlfield.value.length < 6) {
      return controlfield;
    }
    return {tag: controlfield.tag, value: emptyCreationDate(controlfield.value)};
  }

  function emptyCreationDate(f008value) {
  // emptyCreationDate:
  // Normalize f008/00-05 - In non-MARC21 imports f008 'Date entered on file' gets always the current date
  // This propably should be configurable
    debug(`Empty 008 creationDate.`);
    const newValue = `000000${f008value.substring(6)}`;
    debugData(`f008Orig: ${f008value}`);
    debugData(`f008Norm: ${newValue}`);
    return newValue;
  }

  // Sort Aleph internal fields (tags consisting letters) to alphabetical tag order
  // We have also tag-internal sort for:
  // LOW: $a contents
  // SID: $b contents
  // CAT: could be sorted by $c+$h contents - but we do not compare CATs, so sorting CATs are not needed

  function sortAlephInternalFields(fields) {
    const alephInternalPattern = /^[A-Z][A-Z][A-Z]$/u;
    return [...fields].sort((a, b) => {
      // If either of fields is an internal field do sort
      if (alephInternalPattern.test(a.tag) || alephInternalPattern.test(b.tag)) {
        if (a.tag > b.tag) {
          return 1;
        }
        if (b.tag > a.tag) {
          return -1;
        }
        if (a.tag === b.tag && a.tag === 'LOW') {
          return sortLow(a, b);
        }

        if (a.tag === b.tag && a.tag === 'SID') {
          return sortSID(a, b);
        }

        return 0;
      }
      // if neither field is an internal field do not sort
      return 0;
    });
  }

  function sortLow(a, b) {
    if (a.tag !== 'LOW' || b.tag !== 'LOW') {
      return 0;
    }
    if (!a.subfields || !b.subfields) {
      return 0;
    }
    const [aFirstA] = getSubfieldValues(a, 'a');
    const [bFirstA] = getSubfieldValues(b, 'a');

    if (aFirstA > bFirstA) {
      return 1;
    }
    if (bFirstA > aFirstA) {
      return -1;
    }
    return 0;
  }

  function sortSID(a, b) {
    if (a.tag !== 'SID' || b.tag !== 'SID') {
      return 0;
    }
    if (!a.subfields || !b.subfields) {
      return 0;
    }
    const [aFirstB] = getSubfieldValues(a, 'b');
    const [bFirstB] = getSubfieldValues(b, 'b');

    if (aFirstB > bFirstB) {
      return 1;
    }
    if (bFirstB > aFirstB) {
      return -1;
    }
    return 0;
  }

}

