import createDebugLogger from 'debug';
import matchValidator from '@natlibfi/melinda-record-match-validator';
import {MarcRecord} from '@natlibfi/marc-record';
import {format} from '@natlibfi/melinda-rest-api-commons';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:match-validation');
const debugData = debug.extend('data');

export async function matchValidationForMatchResults(record, matchResults, formatOptions) {
  // Format is used to format the candidaterecords (that are in the external format after being fetched from SRU to the internal format)
  const {formatRecord} = format;

  // matches : array of matching candidate records
  // - candidate.id
  // - candidate.record
  // - probability
  // - strategy (if returnStrategy option is true)
  // - treshold (if returnStrategy option is true)
  // - matchQuery (if returnQuery option is true)


  debug(`Sort matchResults by probability`);
  debugData(`Original: ${JSON.stringify(matchResults.map(({candidate: {id}, probability}) => ({id, probability})))}))}`);

  // should this be something else than straigtforward assign?
  const matchResultClone = matchResults;
  // eslint-disable-next-line functional/immutable-data
  const sortedMatchResults = await matchResultClone.sort((a, b) => a.probability > b.probability ? 1 : -1);
  debugData(`Sorted: ${JSON.stringify(sortedMatchResults.map(({candidate: {id}, probability}) => ({id, probability})))}))}`);

  debug(`Run matchValidation for sorted matches (A: incoming record, B database record)`);

  const matchResultsAndMatchValidations = await sortedMatchResults.map(match => {
    // format candidate to MelindaInternalFormat
    debug(`Validating match to candidate ${match.candidate.id}`);
    const matchValidationResult = matchValidation(record, new MarcRecord(formatRecord(match.candidate.record, formatOptions)));
    return {
      matchValidationResult,
      ...match
    };
  });

  // Here we could sort matchValidationResults so that the succesfull and most propable matches come first


  debug(JSON.stringify(matchResultsAndMatchValidations));
  return {record, matchResultsAndMatchValidations};

}

// melinda-record-match-validation is *NOT* async
export function matchValidation(recordA, recordB) {
  debug(`Running match-validation here:`);
  const matchValidationResult = matchValidator(recordA, recordB);
  debug(matchValidationResult);
  return matchValidationResult;
}
