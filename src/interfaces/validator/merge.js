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

export default function ({base, source, baseValidators = {}, sourceValidators = {}}) {
  const reducers = [...MelindaCopyReducerConfigs.map(conf => Reducers.copy(conf)), ...MelindaReducers];

  debug(`Run merge here`);
  const sourceRecord = MarcRecord.clone(source, sourceValidators);
  const baseRecord = MarcRecord.clone(base, baseValidators);

  debugData(`Reducers: ${inspect(reducers, {colors: true, maxArrayLength: 3, depth: 4})})}`);
  debugData(`Source: ${sourceRecord}`);
  debugData(`Base: ${baseRecord}`);

  // test errors:

  const resultRecord = merger({base: baseRecord, source: sourceRecord, reducers, baseValidators: {subfieldValues: false}, sourceValidators: {subfieldValues: false}});
  debugData(`Merge result: ${resultRecord}`);

  const mergeResult = {
    record: resultRecord,
    status: true
  };

  if (!resultRecord) {
    throw new MergeError(HttpStatus.UNPROCESSABLE_ENTITY, `Merge resulted in no record`);
  }

  return mergeResult;
}

