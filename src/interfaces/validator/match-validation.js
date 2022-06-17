import createDebugLogger from 'debug';
import matchValidator from '@natlibfi/melinda-record-match-validator';
import {MarcRecord} from '@natlibfi/marc-record';
import {format} from '@natlibfi/melinda-rest-api-commons';
import {inspect} from 'util';
import {Error as ValidationError} from '@natlibfi/melinda-commons';
import HttpStatus from 'http-status';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:match-validation');
const debugData = debug.extend('data');

export async function matchValidationForMatchResults(record, matchResults, formatOptions, recordMetadata) {
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

  // This could be optimized so that it would be done when it finds the first valid match?

  const matchResultsAndMatchValidations = await matchResultClone.map(match => {
    // format candidate to MelindaInternalFormat
    debug(`Validating match to candidateRecord ${match.candidate.id}`);
    debug(`Formatting candidateRecord to MelindaInternalFormat`);
    const candidateRecord = new MarcRecord(formatRecord(match.candidate.record, formatOptions), {subfieldValues: false});
    //debug(candidateRecord);
    const matchValidationResult = matchValidation(record, candidateRecord);
    return {
      ...matchValidationResult,
      ...match
    };
  });

  // Here we sort matchValidationResults so that the succesfull (action.merge) and most propable (probability) matches come first
  // matchSequence is used to as a tie breaker (matcher is setup to give matchers from id:s first)

  const matchResultsAndMatchValidationsClone = matchResultsAndMatchValidations;
  // eslint-disable-next-line functional/immutable-data
  const sortedValidatedMatchResults = matchResultsAndMatchValidationsClone.sort(sortMatch);
  debugData(inspect(sortedValidatedMatchResults));

  // We could return just the best result for validator?
  // If there are no valid results error

  const validMatchResults = sortedValidatedMatchResults.filter(match => match.action === 'merge');
  debug(`${validMatchResults.length} valid matches`);

  if (validMatchResults.length < 1) {
    throw new ValidationError(HttpStatus.CONFLICT, {message: `MatchValidation for all ${sortedValidatedMatchResults.length} matches failed.`, ids: sortedValidatedMatchResults.map(match => match.candidate.id), recordMetadata});
  }

  const matchValidationResult = {
    record,
    result: validMatchResults[0]
  };

  debug(`Returning first valid result: ${matchValidationResult}}`);
  debugData(`MatchValidationResutlt: ${inspect(matchValidationResult)}`);

  return {matchValidationResult, sortedValidatedMatchResults};
}

// melinda-record-match-validation is *NOT* async
export function matchValidation(recordA, recordB) {
  debug(`Running match-validation here:`);
  debug(`recorA: ${recordA.constructor.name}`);
  // Send records to match-validator as plain objects to avoid problems with differing MarcRecord -versions etc.
  const matchValidationResult = matchValidator(recordA.toObject(), recordB.toObject());
  debugData(inspect(matchValidationResult));
  return matchValidationResult;
}

function sortMatch(a, b) {
  // > 0 sort b before a
  // < 0 sort a before b
  // === 0 keep original order of a and b

  debug(a.action);

  if (a.action === 'merge' && b.action !== 'merge') {
    return -1;
  }

  if (b.action !== 'merge' && a.action === 'merge') {
    return 1;
  }

  if (a.probability === b.probability) {
    return a.matchSequence - b.matchSequence;
  }
  return b.probability - a.probability;
}
