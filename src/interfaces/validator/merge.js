import createDebugLogger from 'debug';
import httpStatus from 'http-status';
import {MarcRecord} from '@natlibfi/marc-record';
import merger from '@natlibfi/marc-record-merge';
//import {inspect} from 'util';
import {MelindaReducers} from '@natlibfi/melinda-marc-record-merge-reducers';
import {Error as MergeError} from '@natlibfi/melinda-commons';

// merge.js
// run merge operation for source and base records

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:merge');
const debugData = debug.extend('data');

export default function ({base, source, recordType}) {
  // Run first copy-reducers with Melinda-configs and then the specific MelindaReducers
  // Do we still have any melinda-configs for copy-reducers?

  debug(' ----- MERGE ----- ');

  /* istanbul ignore next */
  //const melindaCopyReducers = MelindaCopyReducerConfigs.map(conf => Reducers.copy(conf));
  //const reducers = recordType === 'bib' ? [...melindaCopyReducers, ...MelindaReducers] : undefined;
  const reducers = recordType === 'bib' ? MelindaReducers : undefined;

  if (!reducers) {
    debug(`No reducers! RecordType: ${recordType}`);
    throw new MergeError(httpStatus.INTERNAL_SERVER_ERROR, `No merge-reducers specified for ${recordType} records!`);
  }

  //debugData(`Reducers: ${inspect(reducers, {colors: true, maxArrayLength: 10, depth: 8})})}`);

  // We would need to test for errors here

  //debug(`Base is: ${base.constructor.name}`);
  //debugData(base.toString());

  //debug(`Source is: ${source.constructor.name}`);
  //debugData(source.toString());

  // Send records to merge/merge-reducers as MarcRecords
  // NOTE: currently validationOptions {"subfieldValues": false} is hardcoded in merge/mergeReducers
  const result = merger({base, source, reducers});
  //const resultRecord = merger({base: base.toObject(), source: source.toObject(), reducers, baseValidators: {subfieldValues: false}, sourceValidators: {subfieldValues: false}});

  // Currently merge-js return the resulting record as a MarcRecord
  debug(`Merge result is: ${result.constructor.name}`);
  debugData(`${result.toString()}`);

  /* istanbul ignore if  */
  if (!result) {
    throw new MergeError(httpStatus.UNPROCESSABLE_ENTITY, `Merge resulted in no record`);
  }

  const mergeResult = {
    record: new MarcRecord(result, {subfieldValues: false}),
    status: true
  };

  return mergeResult;
}

