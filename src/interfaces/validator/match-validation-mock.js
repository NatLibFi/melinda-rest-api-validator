import createDebugLogger from 'debug';
import matchValidator from '@natlibfi/melinda-record-match-validator';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:match-validation-mock');
//const debugData = debug.extend('data');

export function matchValidationForMatchResults(record, matchResult) {

  // matches : array of matching candidate records
  // - candidate.id
  // - candidate.record
  // - probability
  // - strategy (if returnStrategy option is true)
  // - treshold (if returnStrategy option is true)
  // - matchQuery (if returnQuery option is true)


  debug(`Sort matchResult by probability`);
  const sortedMatchResults = matchResult.sort((a, b) => a.probability > b.probability ? 1 : -1);

  debug(`Run matchValidation for sorted Record`);

  const matchResultsAndMatchValidations = sortedMatchResults.map(match => {
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

export async function matchValidation(recordA, recordB) {
  debug(`Run match-validation here`);
  const matchValidationResult = await matchValidator(recordA, recordB);
  debug(matchValidationResult);
  return matchValidationResult;
}
