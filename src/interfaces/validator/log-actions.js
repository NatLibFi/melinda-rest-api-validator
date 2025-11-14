import {inspect} from 'util';
import {createLogger} from '@natlibfi/melinda-backend-commons';
import {LOG_ITEM_TYPE} from '@natlibfi/melinda-rest-api-commons';

const logger = createLogger();

// logRecord
export function logRecord(mongoLogOperator, {headers, record, recordMetadata, logItemType, logConfig}) {

  if (logConfig) {
    logger.debug(`Logging record to mongoLogs here (logConfig: ${logConfig}): `);
    logger.silly(inspect(headers));
    const catalogerForLog = getCatalogerForLog(headers.cataloger);

    const recordLogItem = {
      logItemType,
      cataloger: catalogerForLog,
      correlationId: headers.correlationId,
      blobSequence: recordMetadata.blobSequence,
      ...recordMetadata,
      record
    };

    logger.silly(`RecordLogItem to add: ${inspect(recordLogItem)}`);
    mongoLogOperator.addLogItem(recordLogItem);

    return;
  }
  logger.debug(`NOT logging record to mongoLogs here (logConfig: ${logConfig}): `);
}

export function logMatchAction(mongoLogOperator, {headers, record, matchResultsForLog = [], matcherReports, logNoMatches = false}) {

  if (!logNoMatches && matchResultsForLog.length < 1) {
    logger.debug(`No matches, logNoMatches: ${logNoMatches} - not logging matchAction to mongoLogs`);
    return;
  }

  logger.debug(`Logging the matchAction to mongoLogs here`);
  logger.silly(inspect(headers));

  const catalogerForLog = getCatalogerForLog(headers.cataloger);

  // matchResultsForLog is an array of matchResult objects:
  // {action, preference: {name, value}, message, candidate: {id, record}, probability, matchSequence}

  // add information from matcherReports to matchResults
  const matchResultsWithReports = matchResultsForLog.map((result) => {
    const matcherReportsForMatch = matcherReports.filter((matcherReport) => matcherReport && matcherReport.matchIds && matcherReport.matchIds.includes(result.candidate.id));
    logger.debug(`${JSON.stringify(matcherReportsForMatch)}`);
    return {
      ...result,
      matcherReports: matcherReportsForMatch
    };
  });

  const matchLogItem = {
    logItemType: LOG_ITEM_TYPE.MATCH_LOG,
    cataloger: catalogerForLog,
    correlationId: headers.correlationId,
    blobSequence: headers.recordMetadata.blobSequence,
    ...headers.recordMetadata,
    incomingRecord: record,
    matchResult: matchResultsWithReports,
    matcherReports
  };

  logger.silly(`MatchLogItem to add: ${inspect(matchLogItem)}`);
  mongoLogOperator.addLogItem(matchLogItem);

  return;
}

export function logMergeAction(mongoLogOperator, {headers, record, preference, existingRecord, id, mergeResult}) {
  logger.silly(inspect(headers));
  logger.debug(`Logging the mergeAction to mongoLogs here`);

  const catalogerForLog = getCatalogerForLog(headers.cataloger);
  // note: there's no correlationId in headers?
  // we want also a timestamp here - mongoLogOperator could create that?

  const mergeLogItem = {
    logItemType: LOG_ITEM_TYPE.MERGE_LOG,
    cataloger: catalogerForLog,
    correlationId: headers.correlationId,
    blobSequence: headers.recordMetadata.blobSequence,
    ...headers.recordMetadata,
    databaseId: id,
    preference: {
      name: preference.name,
      value: preference.value,
      recordName: preference.value === 'A' ? 'incomingRecord' : 'databaseRecord'
    },
    incomingRecord: record,
    databaseRecord: existingRecord,
    mergedRecord: mergeResult.record
  };

  logger.silly(inspect(mergeLogItem));
  mongoLogOperator.addLogItem(mergeLogItem);

  return;
}

export function getCatalogerForLog(cataloger) {
  const catalogerForLog = cataloger.id || cataloger || 'unknown';
  logger.debug(`Picked ${catalogerForLog} from ${JSON.stringify(cataloger)}`);
  return catalogerForLog;
}

