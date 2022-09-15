import HttpStatus from 'http-status';
import createDebugLogger from 'debug';
import {MarcRecord} from '@natlibfi/marc-record';
import merger, {Reducers} from '@natlibfi/marc-record-merge';
import {inspect} from 'util';
import {MelindaReducers, MelindaCopyReducerConfigs} from '@natlibfi/melinda-marc-record-merge-reducers';
import {Error as MergeError} from '@natlibfi/melinda-commons';

// merge.js
// run merge operation for source and base records

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:merge');
const debugData = debug.extend('data');

export default function ({base, source, recordType}) {
  // Run first copy-reducers with Melinda-configs and then the specific MelindaReducers

  const reducers = recordType === 'bib' ? [...MelindaCopyReducerConfigs.map(conf => Reducers.copy(conf)), ...MelindaReducers] : undefined;

  if (!reducers) {
    debug(`No reducers!`);
    throw new MergeError(HttpStatus.INTERNAL_SERVER_ERROR, `No merge-reducers specified for ${recordType} records!`);
  }

  debugData(`Reducers: ${inspect(reducers, {colors: true, maxArrayLength: 10, depth: 8})})}`);

  // We would need to test for errors here

  // Send records to merge as objects
  // NOTE: currently validationOptions {"subfieldValues": false} is hardcoded in merge/mergeReducers
  const result = merger({base: base.toObject(), source: source.toObject(), reducers});
  //const resultRecord = merger({base: base.toObject(), source: source.toObject(), reducers, baseValidators: {subfieldValues: false}, sourceValidators: {subfieldValues: false}});
  debug(`Merge result is: ${result.constructor.name}`);
  debugData(`${result}`);

  const mergeResult = {
    record: new MarcRecord(result, {subfieldValues: false}),
    status: true
  };

  if (!result) {
    throw new MergeError(HttpStatus.UNPROCESSABLE_ENTITY, `Merge resulted in no record`);
  }

  return mergeResult;
}

