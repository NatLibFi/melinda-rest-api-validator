import HttpStatus from 'http-status';
import createDebugLogger from 'debug';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {MarcRecord} from '@natlibfi/marc-record';
import merger, {Reducers} from '@natlibfi/marc-record-merge';
import {inspect} from 'util';
//import validateMatch from '@natlibfi/melinda-record-match-validator';
import {MelindaReducers, MelindaCopyReducerConfigs} from '@natlibfi/melinda-marc-record-merge-reducers';
import {Error as MergeError} from '@natlibfi/melinda-commons';

// merge.js
// run merge operation for source and base records
// should we run match-validation here or in the validator index?
// should we have configurable mergeSettings?

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:merge-mock');
const debugData = debug.extend('data');

export default function ({base, source, baseId = undefined, sourceId = undefined, baseValidators = {}, sourceValidators = {}, matchValidation = false}) {
  const logger = createLogger();
  const reducers = [...MelindaCopyReducerConfigs.map(conf => Reducers.copy(conf)), ...MelindaReducers];

  debug(`Run merge here`);
  const sourceRecord = MarcRecord.clone(source, sourceValidators);
  const baseRecord = MarcRecord.clone(base, baseValidators);

  debugData(`Reducers: ${inspect(reducers, {colors: true, maxArrayLength: 3, depth: 4})})}`);
  debugData(`Source: ${sourceRecord}`);
  debugData(`Base: ${baseRecord}`);

  if (matchValidation) {
    logger.info('Match validation: true');
    //  const result = validateMatch(baseRecord, sourceRecord, true);
    //logger.info(result);
    const resultRecord = merger({base: baseRecord, source: sourceRecord, reducers, baseValidators: {subfieldValues: false}, sourceValidators: {subfieldValues: false}});
    debugData(`Merge result: ${resultRecord}`);
    return resultRecord;
  }

  const resultRecord = merger({base: baseRecord, source: sourceRecord, reducers, baseValidators: {subfieldValues: false}, sourceValidators: {subfieldValues: false}});
  debugData(`Merge result: ${resultRecord}`);

  // We should ascertain that we return the correct id
  const id = baseId || sourceId || undefined;

  const mergeResult = {
    record: resultRecord,
    id,
    report: 'Record merged',
    status: true
  };

  if (!mergeResult) {
    throw new MergeError(HttpStatus.UNPROCESSABLE_ENTITY, `Testing merge Errors`);
  }

  return mergeResult;

}

