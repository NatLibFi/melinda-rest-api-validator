import assert from 'node:assert';
import {describe} from 'node:test';
import createDebugLogger from 'debug';

import generateTests from '@natlibfi/fixugen';
import {READERS} from '@natlibfi/fixura';
import {
  logRecord,
  logMatchAction,
  logMergeAction,
  getCatalogerForLog
} from './log-actions.js';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:log-actions:test');

// Capturing fake: the log functions are plain functions taking the
// mongoLogOperator as their first arg, so no DI seam is needed.
const createFakeMongoLogOperator = () => {
  const logItems = [];
  return {
    logItems,
    addLogItem(logItem) {
      logItems.push(logItem);
    }
  };
};

const getExpectedLogItems = (expectedLogItem = null) =>
  expectedLogItem ? [expectedLogItem] : [];

describe('log-actions', () => {
  describe('log functions with a capturing mongoLogOperator', () => {
    generateTests({
      path: [import.meta.dirname, '..', '..', '..', 'test-fixtures', 'log-actions'],
      useMetadataFile: true,
      recurse: false,
      fixura: {
        reader: READERS.JSON
      },
      callback: ({
        getFixture,
        logFunction,
        logItemType,
        logConfig = null,
        logNoMatches = false,
        cataloger,
        id,
        expectToThrow = false,
        preference,
        expectedLogItem = null,
        expectedCataloger
      }) => {

        const mongoLogOperator = createFakeMongoLogOperator();

        if (logFunction === 'getCatalogerForLog') {
          if (expectToThrow) {
            // Pins current behavior: the 'unknown' fallback in
            // getCatalogerForLog never applies when the cataloger is missing,
            // because cataloger.id throws first.
            assert.throws(() => getCatalogerForLog(cataloger), TypeError);
            return;
          }
          const catalogerForLog = getCatalogerForLog(cataloger);
          debug(`catalogerForLog: ${catalogerForLog}`);
          assert.deepStrictEqual(catalogerForLog, expectedCataloger);
          return;
        }

        const headers = getFixture('headers.json');
        const record = getFixture('record.json');

        if (logFunction === 'logRecord') {
          // logConfig models the logInputRecord / logResultRecord switches
          const recordMetadata = getFixture('recordMetadata.json');
          logRecord(mongoLogOperator, {headers, record, recordMetadata, logItemType, logConfig});
        } else if (logFunction === 'logMatchAction') {
          logMatchAction(mongoLogOperator, {
            headers,
            record,
            matchResultsForLog: getFixture('matchResults.json'),
            matcherReports: getFixture('matcherReports.json'),
            logNoMatches
          });
        } else {
          logMergeAction(mongoLogOperator, {
            headers,
            record,
            preference,
            existingRecord: getFixture('existingRecord.json'),
            id,
            mergeResult: getFixture('mergeResult.json')
          });
        }

        // Assert on the logItem payloads, not on call counts.
        assert.deepStrictEqual(mongoLogOperator.logItems, getExpectedLogItems(expectedLogItem));
      }
    });
  });
});
