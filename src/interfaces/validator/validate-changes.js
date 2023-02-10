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
import {normalizeEmptySubfieldsRecord} from '../../utils';
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
  if (incomingRecord.fields.length !== existingRecord.fields.length) {
    debug(`validateChanges: OK - there are changes between incomingRecord and existingRecord`);
    debugData(`IncomingRecord field count: ${incomingRecord.fields.length}`);
    debugData(`ExistingRecord field count: ${existingRecord.fields.length}`);
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

function normalizeRecord(record) {

  debug(`Normalizing record: empty subfields`);
  //debugData(record);
  // normalizeEmptySubfieldsRecord is an utility function which normalizes all all cases of empty subfield value {code: x, value: ""}, {code: x}, {code: x, value: undefined}  to {value: ""}
  // this is needed, because there are CAT-fields that have empty value in subfield $b
  // we could optimize this step out, if we could be sure that empty subfield values are normalized somewhere else

  const normRecord1 = normalizeEmptySubfieldsRecord(record);
  debug(`Normalizing record: f008/00-05`);
  // Normalize f008/00-05 - In non-MARC21 imports f008 'Date entered on file' gets always the current date
  // This propably should be configurable
  //debugData(normRecord1);
  const normRecord = emptyf008CreationDate(normRecord1);

  return normRecord;
}

function emptyf008CreationDate(record) {
  debugData(record);
  const controlFields = record.getControlfields();
  const normControlFields = controlFields.map(emptyf008);
  //debugData(JSON.stringify(controlFields));

  const dataFields = record.getDatafields();
  const fields = normControlFields.concat(dataFields);
  //debugData(fields);
  return new MarcRecord({leader: record.leader, fields}, {subfieldValues: false});

  function emptyf008(controlfield) {
    if (controlfield.tag !== '008' || controlfield.value.length < 6) {
      return controlfield;
    }
    return {tag: controlfield.tag, value: emptyCreationDate(controlfield.value)};
  }

  function emptyCreationDate(f008value) {
    const newValue = `000000${f008value.substring(6)}`;
    debug(`Emptied creationDate from ${f008value} to ${newValue}`);
    return newValue;
  }

}

