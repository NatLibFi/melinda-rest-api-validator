
import HttpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ValidationError} from '@natlibfi/melinda-commons';

const logger = createLogger();

// eslint-disable-next-line max-statements
export async function iterateMatchersUntilMatchIsFound({matchers, matchOptionsList, updatedRecord, matcherCount = 0, matcherNoRunCount = 0, matcherFalseZeroCount = 0, matcherReports = {}}) {

  const [matcher] = matchers;
  const [matchOptions] = matchOptionsList;

  // eslint-disable-next-line functional/no-conditional-statement
  if (matcher) {

    // eslint-disable-next-line no-param-reassign
    matcherCount += 1;

    const matcherName = matchOptions.matchPackageName;
    logger.debug(`Running matcher ${matcherCount}: ${matcherName}`);
    logger.silly(`MatchingOptions for matcher ${matcherCount}: ${JSON.stringify(matchOptions)}`);

    try {

      // matchResults from melinda-record-matching-js v2.1.0

      // matches : array of matching candidate records
      // nonMatches : array of nonMatching candidate records (if returnNonMatches option is true, otherwise empty array)
      // - candidate.id
      // - candidate.record
      // - probability
      // - strategy (if returnStrategy option is true)
      // - treshold (if returnStrategy option is true)
      // - matchQuery (if returnQuery option is true)

      // we could have here also returnRecords/returnMatchRecords/returnNonMatchRecord options that could be turned false for not to return actual record data

      // matchStatus.status: boolean, true if matcher retrieved and handled all found candidate records, false if it did not
      // matchStatus.stopReason: string ('maxMatches','maxCandidates','maxedQueries',empty string/undefined), reason for stopping retrieving or handling the candidate records
      // - only one stopReason is returned (if there would be several possible stopReasons, stopReason is picked in the above order)
      // - currently stopReason can be non-empty also in cases where status is true, if matcher hit the stop reason when handling the last available candidate record

      const matchResults = await matcher(updatedRecord);

      const {matches, matchStatus} = matchResults;
      const matchAmount = matches.length;

      logger.verbose(`Matcher result: ${JSON.stringify(matchResults)}`);

      // How we should handle cases, where matchResult is false, but we did get match(es)?
      // Should we return also information about the matcher that hit the match (to recognize matches by recordIDs vs other matches?)

      if (matchAmount > 0) { // eslint-disable-line functional/no-conditional-statement

        logger.verbose(`Matching record(s) (${matchAmount}) has been found in matcher ${matcherCount} (${matcherName})`);
        logger.verbose(`MatchStatus for matching records(s) ${JSON.stringify(matchStatus)})`);

        logger.debug(`${JSON.stringify(matches.map(({candidate: {id}, probability}) => ({id, probability})))}`);

        return matches;
      }

      // eslint-disable-next-line functional/no-conditional-statement
      if (matchStatus.status === false) {
        logger.verbose(`Matcher ${matcherName} resulted in ${matchStatus.status}, stopReason ${matchStatus.stopReason}`);
        // eslint-disable-next-line no-param-reassign
        matcherFalseZeroCount += 1;
      }

      logger.debug(`No matching record from matcher ${matcherCount} (${matcherName})`);

      return iterateMatchersUntilMatchIsFound({matchers: matchers.slice(1), matchOptionsList: matchOptionsList.slice(1), updatedRecord, matcherCount, matcherNoRunCount, matcherFalseZeroCount, matcherReports});

    } catch (err) {

      if (err.message === 'Generated query list contains no queries') {
        logger.debug(`Matcher ${matcherCount} (${matcherName}) did not run: ${err.message}`);
        // eslint-disable-next-line no-param-reassign
        matcherNoRunCount += 1;

        // If CONTENT -matcher or last matcher to run did not generate queries, match is not reliable
        if (matcherName === 'CONTENT' || matchers.length <= 1) {
          logger.verbose(`Matcher ${matcherCount} (${matcherName}) could not generate search queries.`);
          throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, err.message);
        }

        return iterateMatchersUntilMatchIsFound({matchers: matchers.slice(1), matchOptionsList: matchOptionsList.slice(1), updatedRecord, matcherCount, matcherNoRunCount, matcherFalseZeroCount, matcherReports});
      }

      // SRU SruSearchErrors are 200-responses that include diagnostics from SRU server
      if (err.message.startsWith('SRU SruSearchError')) {
        logger.verbose(`Matcher ${matcherCount} (${matcherName}) resulted in SRU search error: ${err.message}`);
        throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, err.message);
      }

      // SRU unexpected errors: non-200 responses from SRU server etc.
      if (err.message.startsWith('SRU error')) {
        logger.verbose(`Matcher ${matcherCount} (${matcherName}) resulted in SRU unexpected error: ${err.message}`);
        throw err;
      }

      throw err;
    }
  }

  logger.debug(`All ${matcherCount} matchers handled, ${matcherNoRunCount} did not run.`);

  // eslint-disable-next-line functional/no-conditional-statement
  if (matcherNoRunCount === matcherCount) {
    logger.debug(`None of the matchers resulted in candidates`);
    throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, 'Generated query list contains no queries');
  }

  if (matcherFalseZeroCount > 0) {
    logger.debug(`${matcherFalseZeroCount} matchers returned no matches, but did not check all possible candidates`);
    throw new ValidationError(HttpStatus.CONFLICT, {message: 'Matcher found too many candidates to check'});
  }

  return [];
}

