import createDebugLogger from 'debug';
import matchValidator from '@natlibfi/melinda-record-match-validator';
import {MarcRecord} from '@natlibfi/marc-record';
import {format} from '@natlibfi/melinda-rest-api-commons';
import {inspect} from 'util';

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


  debugData(`Original: ${JSON.stringify(matchResults.map(({candidate: {id}, probability}) => ({id, probability})))}))}`);
  debug(`Add matchSequence`);
  const matchResultClone = matchResults.map((match, index) => ({candidate: match.candidate, probability: match.probability, matchSequence: index}));
  debugData(`Clone: ${JSON.stringify(matchResultClone.map(({candidate: {id}, probability, matchSequence}) => ({id, probability, matchSequence})))}))}`);

  debug(`Run matchValidation for matches (A: incoming record, B: database record)`);

  const matchResultsAndMatchValidations = await matchResultClone.map(match => {
    // format candidate to MelindaInternalFormat
    debug(`Validating match to candidate ${match.candidate.id}`);
    const matchValidationResult = matchValidation(record, new MarcRecord(formatRecord(match.candidate.record, formatOptions)));
    return {
      matchValidationResult,
      ...match
    };
  });

  // Here we sort matchValidationResults so that the succesfull (action.merge) and most propable (probability) matches come first
  // matchSequence is used to as a tie breaker (matcher is setup to give matchers from id:s first)

  const matchResultsAndMatchValidationsClone = matchResultsAndMatchValidations;
  // eslint-disable-next-line functional/immutable-data
  const sortedValidatedMatchResults = matchResultsAndMatchValidationsClone.sort(sortMatch);
  debugData(inspect(sortedValidatedMatchResults));

  return {record, matchResultsAndMatchValidations: sortedValidatedMatchResults};
}

// melinda-record-match-validation is *NOT* async
export function matchValidation(recordA, recordB) {
  debug(`Running match-validation here:`);
  const matchValidationResult = matchValidator(recordA, recordB);
  debugData(inspect(matchValidationResult));
  return matchValidationResult;
}

function sortMatch(a, b) {
  // > 0 sort b before a
  // < 0 sort a before b
  // === 0 keep original order of a and b

  //debug(a.matchValidationResult.action);

  if (a.matchValidationResult === 'merge' && b.matchValidationForMatchResults !== 'merge') {
    return -1;
  }

  if (b.matchValidationResult !== 'merge' && b.matchValidationForMatchResults === 'merge') {
    return 1;
  }

  if (a.probability === b.probability) {
    return a.matchSequence - b.matchSequence;
  }
  return b.probability - a.probability;
}
