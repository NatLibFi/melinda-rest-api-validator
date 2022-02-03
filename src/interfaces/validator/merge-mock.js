import createDebugLogger from 'debug';
import {MarcRecord} from '@natlibfi/marc-record';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:merge-mock');
const debugData = debug.extend('data');

export default ({base, source, reducers = [], baseValidators = {}, sourceValidators = {}}) => {
  debug(`Run merge here`);
  const sourceRecord = MarcRecord.clone(source, sourceValidators);
  const baseRecord = MarcRecord.clone(base, baseValidators);
  debugData(`Reducers: ${JSON.stringify(reducers)}`);
  debugData(`Source: ${sourceRecord}`);
  debugData(`Base: ${baseRecord}`);

  const mergeResult = reducers.reduce((baseRecord, reducer) => reducer(baseRecord, sourceRecord), MarcRecord.clone(base, baseValidators));
  debug(mergeResult);

};
