import createDebugLogger from 'debug';
import matchValidator from '@natlibfi/melinda-record-match-validator';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:match-validation-mock');
const debugData = debug.extend('data');

export async function matchValidationForMatchResults(record, matchResults) {

  // matches : array of matching candidate records
  // - candidate.id
  // - candidate.record
  // - probability
  // - strategy (if returnStrategy option is true)
  // - treshold (if returnStrategy option is true)
  // - matchQuery (if returnQuery option is true)


  debug(`Sort matchResults by probability`);
  debugData(`Original: ${JSON.stringify(matchResults.map(({candidate: {id}, probability}) => ({id, probability})))}))}`);

  const matchResultClone = matchResults;
  // eslint-disable-next-line functional/immutable-data
  const sortedMatchResults = await matchResultClone.sort((a, b) => a.probability > b.probability ? 1 : -1);
  debugData(`Sorted: ${JSON.stringify(sortedMatchResults.map(({candidate: {id}, probability}) => ({id, probability})))}))}`);

  debug(`Run matchValidation for sorted matches`);

  const matchResultsAndMatchValidations = await sortedMatchResults.map(match => {
    const matchValidationResult = matchValidation(record, match.candidate.record);
    return {
      matchValidationResult,
      ...match
    };
  });

  debug(JSON.stringify(matchResultsAndMatchValidations));
  return {record, matchResultsAndMatchValidations};

}

/*
export async function matchValidationRecordArray(record, matchResultRecords, validateUntilValid = true) {
  debug(``);
  const matchValidationResults = await matchResultRecords.forEach(matchedRecord => {
    return matchValidation(record, matchedRecord);
  });

  return {record, matchResultRecords};
}
*/

// melinda-record-match-validation is *NOT* async
export function matchValidation(recordA, recordB) {
  debug(`Run match-validation here`);
  const matchValidationResult = matchValidator(recordA, recordB);
  debug(matchValidationResult);
  return matchValidationResult;
}
