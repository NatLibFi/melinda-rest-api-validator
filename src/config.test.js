import assert from 'node:assert';
import {describe, it} from 'node:test';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

import {fixes} from '@natlibfi/melinda-rest-api-commons';
import {candidateSearch, matchDetection} from '@natlibfi/melinda-record-matching';

const CONFIG_PATH = path.join(import.meta.dirname, 'config.js');

// All config env is read at import time (module-scope exports), and the
// exports are evaluated once per process. Each case is therefore run in its
// own subprocess: the child imports src/config.js with a specific env and
// prints the selected exports as one JSON line, which the parent asserts on.
// Related assertions are batched per spawn to keep the spawn count sane.
const MANAGED_VARIABLES = [
  'POLL_REQUEST',
  'POLL_WAIT_TIME',
  'AMQP_URL',
  'MONGO_URI',
  'RECORD_TYPE',
  'SRU_URL',
  'FAIL_BULK_ON_ERROR',
  'KEEP_SPLITTER_REPORT',
  'VALIDATOR_MATCH_PACKAGES',
  'STOP_WHEN_FOUND',
  'ACCEPT_ZERO_WITH_MAX_CANDIDATES',
  'LOG_NO_MATCHES',
  'LOG_INPUT_RECORD',
  'LOG_RESULT_RECORD',
  'MATCH_FAILURES_AS_NEW',
  'MATCHING_TRESHOLD',
  'MAX_MATCHES',
  'MAX_CANDIDATES'
];

const createChildEnv = (overrides) => {
  const env = {...process.env};
  MANAGED_VARIABLES.forEach(variable => delete env[variable]);
  return {...env, ...overrides};
};

const CONFIG_DUMP_SCRIPT = `
import * as config from ${JSON.stringify(pathToFileURL(CONFIG_PATH).href)};
const replacer = (key, value) => (value instanceof RegExp ? 'REGEX:' + value.source : value);
const dump = JSON.parse(JSON.stringify({
  pollRequest: config.pollRequest,
  pollWaitTime: config.pollWaitTime,
  amqpUrl: config.amqpUrl,
  mongoUri: config.mongoUri,
  splitterOptions: config.splitterOptions,
  validatorOptions: config.validatorOptions
}, replacer));
console.log('CONFIG_DUMP ' + JSON.stringify(dump));
`;

const runConfigDump = (overrides) => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', CONFIG_DUMP_SCRIPT], {
    env: createChildEnv(overrides),
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    return {exitCode: result.status, error: `${result.stderr}\n${result.stdout}`};
  }
  const line = result.stdout.split('\n').find((line) => line.startsWith('CONFIG_DUMP '));
  const dump = JSON.parse(line.slice('CONFIG_DUMP '.length));
  // The strategy objects carry compare/extract functions which JSON.stringify
  // drops in the child; compare by name in the parent instead.
  dump.validatorOptions.matchOptionsList = dump.validatorOptions.matchOptionsList.map(
    (options) => ({
      ...options,
      detection: {
        ...options.detection,
        strategy: options.detection.strategy.map((feature) => feature.name)
      }
    })
  );
  return {exitCode: 0, dump};
};

const BSR = candidateSearch.searchTypes.bib;
const BF = matchDetection.features.bib;

const BIB_SEARCH_SPECS = {
  IDS: [BSR.melindaId, BSR.sourceIds],
  STANDARD_IDS: [BSR.standardIdentifiers],
  CONTENT: [BSR.hostComponents, BSR.title],
  CONTENTALT: [BSR.hostComponents, BSR.titleAuthorYearAlternates]
};

const STANDARD_IDS_STRATEGY = [
  BF.hostComponent(),
  BF.isbn(),
  BF.issn(),
  BF.publisherNumber(),
  BF.otherStandardIdentifier(),
  BF.authors(),
  BF.recordType(),
  BF.publicationTimeAllowConsYearsMulti(),
  BF.language(),
  BF.bibliographicLevel()
];

const CONTENT_STRATEGY = [
  BF.hostComponent(),
  BF.isbn(),
  BF.issn(),
  BF.publisherNumber(),
  BF.otherStandardIdentifier(),
  BF.title(),
  BF.authors(),
  BF.recordType(),
  BF.publicationTime(),
  BF.language(),
  BF.bibliographicLevel()
];

const BIB_STRATEGIES = {
  IDS: [BF.melindaId(), BF.allSourceIds()],
  STANDARD_IDS: STANDARD_IDS_STRATEGY,
  CONTENT: CONTENT_STRATEGY,
  CONTENTALT: CONTENT_STRATEGY
};

const BIB_MAX_MATCHES = {IDS: 1, STANDARD_IDS: 10, CONTENT: 10, CONTENTALT: 10};
const BIB_MAX_CANDIDATES = {IDS: 50, STANDARD_IDS: 50, CONTENT: 50, CONTENTALT: 150};

// Note: readEnvironmentVariable does not run the format function over
// defaults, so unset boolean switches stay numeric 0/1 (not false/true).
const DEFAULT_LOG_OPTIONS = {logNoMatches: 0, logInputRecord: 0, logResultRecord: 0};

const getExpectedMatchOptions = (packages, {sruUrl, treshold = 0.9}) =>
  packages.map((matchPackageName) => ({
    matchPackageName,
    maxMatches: BIB_MAX_MATCHES[matchPackageName],
    maxCandidates: BIB_MAX_CANDIDATES[matchPackageName],
    returnFailures: true,
    search: {url: sruUrl, searchSpec: BIB_SEARCH_SPECS[matchPackageName]},
    detection: {
      treshold,
      strategy: BIB_STRATEGIES[matchPackageName].map((feature) => feature.name)
    }
  }));

const getExpectedValidatorOptions = ({
  recordType,
  preValidationFixOptions,
  postMergeFixOptions,
  sruUrl,
  matchPackages,
  treshold,
  stopWhenFound,
  acceptZeroWithMaxCandidates,
  matchFailuresAsNew,
  logOptions
}) => ({
  recordType,
  preValidationFixOptions,
  postMergeFixOptions,
  // The current behavior reuses the BIB preimport fix settings for autname too.
  preImportFixOptions: fixes.BIB_PREIMPORT_FIX_SETTINGS,
  sruUrl,
  matchOptionsList: getExpectedMatchOptions(matchPackages, {sruUrl, treshold}),
  stopWhenFound,
  acceptZeroWithMaxCandidates,
  matchFailuresAsNew,
  logOptions
});

const BIB_FIX_OPTIONS = {
  preValidationFixOptions: fixes.BIB_PREVALIDATION_FIX_SETTINGS,
  postMergeFixOptions: fixes.BIB_POSTMERGE_FIX_SETTINGS
};

const BIB_OVERRIDES = {
  RECORD_TYPE: 'bib',
  SRU_URL: 'http://sru.over',
  POLL_REQUEST: '1',
  POLL_WAIT_TIME: '50',
  AMQP_URL: 'amqp://127.0.0.1:5673/',
  MONGO_URI: 'mongodb://127.0.0.1:27018/db',
  FAIL_BULK_ON_ERROR: '0',
  KEEP_SPLITTER_REPORT: 'ALL',
  VALIDATOR_MATCH_PACKAGES: 'IDS,CONTENTALT',
  STOP_WHEN_FOUND: '0',
  ACCEPT_ZERO_WITH_MAX_CANDIDATES: '1',
  MATCH_FAILURES_AS_NEW: '1',
  LOG_NO_MATCHES: '1',
  LOG_INPUT_RECORD: '1',
  LOG_RESULT_RECORD: '1',
  MATCHING_TRESHOLD: '0.5'
};

const assertThrow = ({exitCode, error}, message) => {
  assert.strictEqual(exitCode, 1);
  assert.ok(error.includes(message), `expected error to include: ${message}`);
};

// Mirror of the child-process replacer (see CONFIG_DUMP_SCRIPT).
const serializeForComparison = (value) => JSON.parse(JSON.stringify(value,
  (key, v) => (v instanceof RegExp ? `REGEX:${v.source}` : v)
));

describe('config option building (subprocess: env is read at import time)', () => {
  it('builds the default bib options', () => {
    const {exitCode, dump} = runConfigDump({RECORD_TYPE: 'bib', SRU_URL: 'http://sru.bib'});
    assert.strictEqual(exitCode, 0);
    const expected = serializeForComparison({
      pollRequest: 0,
      pollWaitTime: 1000,
      amqpUrl: 'amqp://127.0.0.1:5672/',
      mongoUri: 'mongodb://127.0.0.1:27017/db',
      splitterOptions: {failBulkOnError: 1, keepSplitterReport: 'ERROR'},
      validatorOptions: getExpectedValidatorOptions({
        recordType: 'bib',
        ...BIB_FIX_OPTIONS,
        sruUrl: 'http://sru.bib',
        matchPackages: ['IDS', 'STANDARD_IDS', 'CONTENTALT'],
        stopWhenFound: 1,
        acceptZeroWithMaxCandidates: 0,
        matchFailuresAsNew: false,
        logOptions: DEFAULT_LOG_OPTIONS
      })
    });
    assert.deepStrictEqual(dump, expected);
  });

  it('applies environment variable overrides for bib', () => {
    const {exitCode, dump} = runConfigDump(BIB_OVERRIDES);
    assert.strictEqual(exitCode, 0);
    const expected = serializeForComparison({
      pollRequest: true,
      pollWaitTime: 50,
      amqpUrl: 'amqp://127.0.0.1:5673/',
      mongoUri: 'mongodb://127.0.0.1:27018/db',
      splitterOptions: {failBulkOnError: false, keepSplitterReport: 'ALL'},
      validatorOptions: getExpectedValidatorOptions({
        recordType: 'bib',
        ...BIB_FIX_OPTIONS,
        sruUrl: 'http://sru.over',
        matchPackages: ['IDS', 'CONTENTALT'],
        treshold: 0.5,
        stopWhenFound: false,
        acceptZeroWithMaxCandidates: true,
        matchFailuresAsNew: true,
        logOptions: {logNoMatches: true, logInputRecord: true, logResultRecord: true}
      })
    });
    assert.deepStrictEqual(dump, expected);
  });

  it('builds the autname options (matching disabled, no pre/post-merge fixes)', () => {
    const {exitCode, dump} = runConfigDump({RECORD_TYPE: 'autname', SRU_URL: 'http://sru.autname'});
    assert.strictEqual(exitCode, 0);
    assert.deepStrictEqual(dump.validatorOptions, serializeForComparison(getExpectedValidatorOptions({
      recordType: 'autname',
      preValidationFixOptions: {},
      postMergeFixOptions: {},
      sruUrl: 'http://sru.autname',
      matchPackages: [],
      stopWhenFound: 1,
      acceptZeroWithMaxCandidates: 0,
      matchFailuresAsNew: false,
      logOptions: DEFAULT_LOG_OPTIONS
    })));
  });

  it('builds the CONTENT package options (bib)', () => {
    const {exitCode, dump} = runConfigDump({
      RECORD_TYPE: 'bib',
      SRU_URL: 'http://sru.content',
      VALIDATOR_MATCH_PACKAGES: 'CONTENT'
    });
    assert.strictEqual(exitCode, 0);
    assert.deepStrictEqual(dump.validatorOptions.matchOptionsList, serializeForComparison(
      getExpectedMatchOptions(['CONTENT'], {sruUrl: 'http://sru.content'})
    ));
  });
});

// The throw cases abort the module at import time, so the options that were
// already generated (preValidationFixOptions et al.) cannot be observed.
describe('config import failures (subprocess)', () => {
  it('throws at import for an unsupported RECORD_TYPE', () => {
    const result = runConfigDump({RECORD_TYPE: 'foo', SRU_URL: 'http://sru'});
    assertThrow(result, 'Unsupported record type foo');
  });

  it('throws at import when RECORD_TYPE is missing', () => {
    const result = runConfigDump({SRU_URL: 'http://sru'});
    assertThrow(result, 'Mandatory environment variable missing: RECORD_TYPE');
  });

  it('throws at import when SRU_URL is missing', () => {
    const result = runConfigDump({RECORD_TYPE: 'bib'});
    assertThrow(result, 'Mandatory environment variable missing: SRU_URL');
  });

  it('throws at import for an unsupported match package (bib)', () => {
    const result = runConfigDump({
      RECORD_TYPE: 'bib',
      SRU_URL: 'http://sru',
      VALIDATOR_MATCH_PACKAGES: 'FOO'
    });
    assertThrow(result, 'Unsupported match validation package');
  });
});
