
import HttpStatus from 'http-status';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {Error as ValidationError} from '@natlibfi/melinda-commons';
import {inspect} from 'util';

const logger = createLogger();

// stopWhenFound = stop iterating matchers when the first match is found

// eslint-disable-next-line max-statements
export async function iterateMatchers({matchers, matchOptionsList, record, stopWhenFound = true, matcherCount = 0, matcherNoRunCount = 0, matcherFalseZeroCountMaxedQueries = 0, matcherFalseZeroCountConversionFailures = 0, matcherReports = {}, allConversionFailures = [], allMatches = [], allStatus = true}) {

  logger.debug(`Matchers left: ${matchers.length}`);

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

      // matchResults from melinda-record-matching-js v2.2.0

      // matches : array of matching candidate records
      // nonMatches : array of nonMatching candidate records (if returnNonMatches option is true, otherwise empty array)
      // - candidate.id
      // - candidate.record
      // - probability
      // - strategy (if returnStrategy option is true)
      // - treshold (if returnStrategy option is true)
      // - matchQuery (if returnQuery option is true)
      // conversionFailures: array of errors contents ({status, payload: {message, id, data}}) (if returnFailures is true)

      // we could have here also returnRecords/returnMatchRecords/returnNonMatchRecord options that could be turned false for not to return actual record data

      // matchStatus.status: boolean, true if matcher retrieved and handled all found candidate records, false if it did not
      // matchStatus.stopReason: string ('maxMatches','maxCandidates','maxedQueries', 'conversionFailures', 'matchErrors' empty string/undefined), reason for stopping retrieving or handling the candidate records
      // - only one stopReason is returned (if there would be several possible stopReasons, stopReason is picked in the above order)
      // - currently stopReason can be non-empty also in cases where status is true, if matcher hit the stop reason when handling the last available candidate record

      // Note: candidate.record is in external format (as it is fetched from SRU)

      const matchResults = await matcher(record);

      const {matches, matchStatus, conversionFailures} = matchResults;

      logger.verbose(`MatchStatus: ${JSON.stringify(matchStatus)})`);
      logger.silly(`MatchResult: ${inspect(matchResults, {colors: true, maxArrayLength: 10, depth: 3})}`);

      logger.debug(`Conversion failures: ${conversionFailures.length}`);
      logger.silly(`Conversion failures: ${JSON.stringify(conversionFailures.map(f => f.payload.id))}`);

      // We probably want to log conversionFailures somewhere here - currently conversionFailures are logged only when matching fails due to them
      const newConversionFailures = allConversionFailures.concat(...conversionFailures);

      const newMatches = allMatches.concat(matches);
      const newAllStatus = matchStatus.status === false ? false : allStatus;
      const matchAmount = matches.length;

      // How we should handle cases, where matchResult is false, but we did get match(es)?
      // Should we return also information about the matcher that hit the match (to recognize matches by recordIDs vs other matches?)

      if (stopWhenFound && matchAmount > 0) { // eslint-disable-line functional/no-conditional-statement

        logger.verbose(`Matching record(s) (${matchAmount}) has been found in matcher ${matcherCount} (${matcherName}) - stopWhenFound active.`);

        logger.debug(`Matches: ${JSON.stringify(matches.map(({candidate: {id}, probability}) => ({id, probability})))}`);

        logger.debug(`${matcherCount} matchers handled, ${matchers.length - 1} matchers left. ${matcherNoRunCount} did not run.`);
        logger.debug(`We had ${allConversionFailures.length} conversion failures from matcher`);

        const uniqMatches = uniqueMatches(matches);

        return {matches: uniqMatches};
      }

      if (matchAmount === 0) {
        logger.debug(`No matching record(s) from matcher ${matcherCount} (${matcherName})`);
        // eslint-disable-next-line functional/no-conditional-statement
        if (matchStatus.status === false && matchStatus.stopReason === 'maxedQueries') {
          logger.verbose(`Matcher ${matcherName} resulted in ${matchStatus.status}, stopReason ${matchStatus.stopReason}`);
          // eslint-disable-next-line no-param-reassign
          matcherFalseZeroCountMaxedQueries += 1;
        }

        // eslint-disable-next-line functional/no-conditional-statement
        if (matchStatus.status === false && matchStatus.stopReason === 'conversionFailures') {
          logger.verbose(`Matcher ${matcherName} resulted in ${matchStatus.status}, stopReason ${matchStatus.stopReason}`);
          // eslint-disable-next-line no-param-reassign
          matcherFalseZeroCountConversionFailures += 1;
        }
      }

      return iterateMatchers({matchers: matchers.slice(1), matchOptionsList: matchOptionsList.slice(1), stopWhenFound, record, matcherCount, matcherNoRunCount, matcherFalseZeroCountMaxedQueries, matcherFalseZeroCountConversionFailures, matcherReports, allConversionFailures: newConversionFailures, allMatches: newMatches, allStatus: newAllStatus});

    } catch (err) {

      logger.debug(`Matcher errored: ${JSON.stringify(err)}`);

      if (err.message === 'Generated query list contains no queries') {
        logger.debug(`Matcher ${matcherCount} (${matcherName}) did not run: ${err.message}`);
        // eslint-disable-next-line no-param-reassign
        matcherNoRunCount += 1;

        // If CONTENT -matcher or last matcher to run did not generate queries, match is not reliable
        if (matcherName === 'CONTENT' || matchers.length <= 1) {
          logger.verbose(`Matcher ${matcherCount} (${matcherName}) could not generate search queries.`);
          throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, {message: err.message});
        }

        return iterateMatchers({matchers: matchers.slice(1), matchOptionsList: matchOptionsList.slice(1), stopWhenFound, record, matcherCount, matcherNoRunCount, matcherFalseZeroCountMaxedQueries, matcherFalseZeroCountConversionFailures, matcherReports, allMatches, allStatus});
      }

      // SRU SruSearchErrors are 200-responses that include diagnostics from SRU server
      if (err.message.startsWith('SRU SruSearchError')) {
        logger.verbose(`Matcher ${matcherCount} (${matcherName}) resulted in SRU search error: ${err.message}`);
        throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, {message: err.message});
      }

      // SRU unexpected errors: non-200 responses from SRU server etc.
      if (err.message.startsWith('SRU error')) {
        logger.verbose(`Matcher ${matcherCount} (${matcherName}) resulted in SRU unexpected error: ${err.message}`);
        throw new Error(err);
      }

      throw new Error(err);
    }
  }
  // if no more matchers
  logger.debug(`All ${matcherCount} matchers handled, ${matcherNoRunCount} did not run.`);
  logger.debug(`-- We had ${allMatches.length} matches from the matchers`);
  logger.debug(`-- We had ${allConversionFailures.length} conversion failures from the matchers`);
  logger.debug(`-- All matchers returned true status: ${allStatus}`);

  // eslint-disable-next-line functional/no-conditional-statement
  if (allMatches.length < 1) {
    logger.debug(`We did not find any matches. Checking if this is a trustworthy result.`);

    // Fail if we could not create any search queries from the record
    if (matcherNoRunCount === matcherCount) {
      logger.debug(`None of the matchers could generate search query for candidates`);
      throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, {message: 'Generated query list contains no queries'});
    }

    // Fail if we got too many search candidates and no matches
    if (matcherFalseZeroCountMaxedQueries > 0) {
      logger.debug(`${matcherFalseZeroCountMaxedQueries} matchers returned no matches, but did not check all possible candidates`);
      throw new ValidationError(HttpStatus.CONFLICT, {message: `Matcher found too many candidates to check`});
    }

    // Fail if we got conversionFailures and no matches
    if (matcherFalseZeroCountConversionFailures > 0) {
      logger.debug(`${matcherFalseZeroCountConversionFailures} matchers returned no matches, but had non-convertable candidates.`);

      // Matcher does not curently find ids for conversionFailures, but might do that later
      const nonZeroConversionFailureIds = allConversionFailures.map(f => f.payload.id).filter(id => id !== '000000000');
      const uniqConversionFailureIds = [...new Set(nonZeroConversionFailureIds)];
      logger.debug(`Non-zero conversionFailureIds: ${JSON.stringify(nonZeroConversionFailureIds)}`);
      logger.debug(`Unique conversionFailureIds: ${JSON.stringify(uniqConversionFailureIds)}`);

      throw new ValidationError(HttpStatus.UNPROCESSABLE_ENTITY, {message: `Matcher found only non-convertable candidates to check`, ids: uniqConversionFailureIds});
    }
    logger.debug(`No reasons to suspect the results with 0 matches.`);
  }

  // Unique matches
  const uniqMatches = uniqueMatches(allMatches);
  logger.debug(`All matches (${allMatches.length}): ${JSON.stringify(allMatches.map(match => match.candidate.id))}`);
  logger.debug(`Unique matches (${uniqMatches.length}): ${JSON.stringify(uniqMatches.map(match => match.candidate.id))}`);

  return {matches: uniqMatches};
}

function uniqueMatches(matches) {
  const uniqueMatches = [...new Map(matches.map((match) => [match.candidate.id, match])).values()];
  return uniqueMatches;
}


