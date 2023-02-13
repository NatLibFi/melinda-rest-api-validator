/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* RESTful API for Melinda - record validation services
*
* Copyright (C) 2022 University Of Helsinki (The National Library Of Finland)
*
* This file is part of melinda-rest-api-validator
*
* melinda-rest-api-validator program is free software: you can redistribute it and/or modify
* it under the terms of the GNU Affero General Public License as
* published by the Free Software Foundation, either version 3 of the
* License, or (at your option) any later version.
*
* melinda-rest-api-validator is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU Affero General Public License for more details.
*
* You should have received a copy of the GNU Affero General Public License
* along with this program.  If not, see <http://www.gnu.org/licenses/>.
*
* @licend  The above is the entire license notice
* for the JavaScript code in this file.
*
*/

import deepEqual from 'deep-eql';
import {detailedDiff} from 'deep-object-diff';
import createDebugLogger from 'debug';
import {normalizeEmptySubfields} from '../../utils';
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
  if (incomingRecord.fields.filter(isActualContentField).length !== existingRecord.fields.filter(isActualContentField).length) {
    debug(`validateChanges: OK - there are changes between incomingRecord and existingRecord`);
    debugData(`IncomingRecord field count: ${incomingRecord.fields.length}`);
    debugData(`IncomingRecord field tags: ${incomingRecord.fields.map(field => field.tag)}`);
    debugData(`ExistingRecord field count: ${existingRecord.fields.length}`);
    debugData(`ExistingRecord field tags: ${existingRecord.fields.map(field => field.tag)}`);
    return {changeValidationResult: true};
  }

  //debug(`ic`);
  const normIncomingRecord = normalizeRecord(incomingRecord);
  //debug(`db`);
  const normExistingRecord = normalizeRecord(existingRecord);

  if (deepEqual(normIncomingRecord, normExistingRecord) === true) { // eslint-disable-line functional/no-conditional-statement

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
  return field.tag !== '001' && field.tag !== '003';
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

  function sortAlephInternalFields(fields) {
    const alephInternalPattern = /^[A-Z][A-Z][A-Z]$/u;
    return [...fields].sort((a, b) => {
      // If either of fields is and internal field do sort
      if (alephInternalPattern.test(a.tag) || alephInternalPattern.test(b.tag)) {
        if (a.tag > b.tag) {
          return 1;
        }
        if (b.tag > a.tag) {
          return -1;
        }
        return 0;
      }
      // if neither field is an internal field do not sort
      return 0;
    });
  }

}

