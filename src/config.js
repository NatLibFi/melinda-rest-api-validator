
import createDebugLogger from 'debug';
import {parseBoolean} from '@natlibfi/melinda-commons';
import {readEnvironmentVariable} from '@natlibfi/melinda-backend-commons';
import {candidateSearch, matchDetection} from '@natlibfi/melinda-record-matching';
import {fixes} from '@natlibfi/melinda-rest-api-commons';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:config');
//const debugData = debug.extend('data');

// Poll variables
export const pollRequest = readEnvironmentVariable('POLL_REQUEST', {defaultValue: 0, format: v => parseBoolean(v)});
export const pollWaitTime = parseInt(readEnvironmentVariable('POLL_WAIT_TIME', {defaultValue: 1000}), 10);

// Amqp variables to priority
export const amqpUrl = readEnvironmentVariable('AMQP_URL', {defaultValue: 'amqp://127.0.0.1:5672/'});

// Mongo variables to bulk
export const mongoUri = readEnvironmentVariable('MONGO_URI', {defaultValue: 'mongodb://127.0.0.1:27017/db'});

export const recordType = readEnvironmentVariable('RECORD_TYPE');

export const splitterOptions = {
  // failBulkError: fail processing whole bulk of records if there's error on serializing a record
  failBulkOnError: readEnvironmentVariable('FAIL_BULK_ON_ERROR', {defaultValue: 1, format: v => parseBoolean(v)}),
  // keepSplitterReport: ALL/NONE/ERROR
  keepSplitterReport: readEnvironmentVariable('KEEP_SPLITTER_REPORT', {defaultValue: 'ERROR'})
};

//const validatorMatchPackages = readEnvironmentVariable('VALIDATOR_MATCH_PACKAGES', {defaultValue: 'IDS,STANDARD_IDS,CONTENT'}).split(',');
const validatorMatchPackages = readEnvironmentVariable('VALIDATOR_MATCH_PACKAGES', {defaultValue: 'IDS,STANDARD_IDS,CONTENTALT'}).split(',');
const stopWhenFound = readEnvironmentVariable('STOP_WHEN_FOUND', {defaultValue: 1, format: v => parseBoolean(v)});
const acceptZeroWithMaxCandidates = readEnvironmentVariable('ACCEPT_ZERO_WITH_MAX_CANDIDATES', {defaultValue: 0, format: v => parseBoolean(v)});
const logNoMatches = readEnvironmentVariable('LOG_NO_MATCHES', {defaultValue: 0, format: v => parseBoolean(v)});
const logInputRecord = readEnvironmentVariable('LOG_INPUT_RECORD', {defaultValue: 0, format: v => parseBoolean(v)});
const logResultRecord = readEnvironmentVariable('LOG_RESULT_RECORD', {defaultValue: 0, format: v => parseBoolean(v)});

// Match selector rules, in priority order. Each rule extracts a key from the record;
// rules are evaluated in this order and a match on an earlier rule wins.
// - MELINDA_ID: same melinda-id (035 $a/$z with FI-MELINDA prefix)
// - LOCAL_SID: same local SID (same $b, same $c)
// - SAME_LOW: same LOW $a
// - NAT_BIB: national bibliography record (042 $a = finb/finbd)
// - LOW_COUNT: number of LOW fields
// - ENCODING_LEVEL: encoding level (LDR/17)
// - PREPUB_LEVEL: prepublication level (5XX-based)
const KNOWN_MATCH_SELECTOR_RULES = [
  'MELINDA_ID',
  'LOCAL_SID',
  'SAME_LOW',
  'NAT_BIB',
  'LOW_COUNT',
  'ENCODING_LEVEL',
  'PREPUB_LEVEL'
];

// Note: matchFailuresAsNew from operationSettings of the job overrides this default setting given in environmental variables
const matchFailuresAsNew = readEnvironmentVariable('MATCH_FAILURES_AS_NEW', {defaultValue: false, format: v => parseBoolean(v)});

// We could have also settings matchValidation and merge here

// MATCHING_TRESHOLD is the deprecated spelling of MATCHING_THRESHOLD.
// The correctly spelled name wins; the old name still works as a fallback.
const usesDeprecatedThresholdVariable = process.env.MATCHING_THRESHOLD === undefined && process.env.MATCHING_TRESHOLD !== undefined;
if (usesDeprecatedThresholdVariable) {
  console.warn('Environment variable MATCHING_TRESHOLD is deprecated and will be removed in a future major version. Use MATCHING_THRESHOLD instead.'); // eslint-disable-line no-console
}

export const validatorOptions = {
  recordType,
  preValidationFixOptions: generatePreValidationFixOptions(),
  postMergeFixOptions: generatePostMergeFixOptions(),
  preImportFixOptions: generatePreImportFixOptions(),
  sruUrl: readEnvironmentVariable('SRU_URL'),
  matchOptionsList: generateMatchOptionsList(),
  // Match selector rules live in validatorOptions (instead of a separate top-level export)
  // because validatorOptions is the single config object consumed by the matching code,
  // and the match selector runs as part of match validation, next to matchOptionsList
  matchSelectorRules: generateMatchSelectorRules(),
  stopWhenFound,
  acceptZeroWithMaxCandidates,
  matchFailuresAsNew,
  logOptions: {logNoMatches, logInputRecord, logResultRecord}
};

function generateMatchOptionsList() {
  if (recordType === 'bib') {
    return validatorMatchPackages.map(matchPackage => generateMatchOptions(matchPackage));
  }
  if (recordType === 'autname') {
    return [];
  }
  throw new Error(`Unsupported record type ${recordType}`);
}

function generateMatchSelectorRules() {
  const matchSelectorRules = readEnvironmentVariable('MATCH_SELECTOR_RULES', {
    defaultValue: KNOWN_MATCH_SELECTOR_RULES.join(',')
  }).split(',');

  const unknownRules = matchSelectorRules.filter(rule => !KNOWN_MATCH_SELECTOR_RULES.includes(rule));
  if (unknownRules.length > 0) {
    throw new Error(`Unknown match selector rules: ${unknownRules.join(', ')}`);
  }

  debug(`Match selector rules: ${matchSelectorRules.join(', ')}`);
  return matchSelectorRules;
}

function generateMatchOptions(validatorMatchPackage) {
  return {
    matchPackageName: validatorMatchPackage,
    maxMatches: generateMaxMatches(validatorMatchPackage),
    maxCandidates: generateMaxCandidates(validatorMatchPackage),
    returnFailures: true,
    search: {
      url: readEnvironmentVariable('SRU_URL'),
      searchSpec: generateSearchSpec(validatorMatchPackage)
    },
    detection: {
      threshold: generateThreshold(validatorMatchPackage),
      strategy: generateStrategy(validatorMatchPackage)
    }
  };
}

function generateMaxMatches(validatorMatchPackage) {
  if (['IDS'].includes(validatorMatchPackage)) {
    const value = 1;
    debug(`MaxMatches for ${validatorMatchPackage} is defined in in config: ${value}`);
    return value;
  }

  if (['STANDARD_IDS'].includes(validatorMatchPackage)) {
    const value = 10;
    debug(`MaxMatches for ${validatorMatchPackage} is defined in in config: ${value}`);
    return value;
  }

  if (['CONTENT', 'CONTENTALT'].includes(validatorMatchPackage)) {
    const value = 10;
    debug(`MaxMatches for ${validatorMatchPackage} is defined in in config: ${value}`);
    return value;
  }

  debug(`MaxMatches for ${validatorMatchPackage} uses environment variable`);
  return readEnvironmentVariable('MAX_MATCHES', {defaultValue: 1, format: v => Number(v)});
}

function generateMaxCandidates(validatorMatchPackage) {
  if (['IDS'].includes(validatorMatchPackage)) {
    const value = 50;
    debug(`MaxCandidates for ${validatorMatchPackage} is defined in in config: ${value}`);
    return value;
  }

  if (['STANDARD_IDS'].includes(validatorMatchPackage)) {
    const value = 50;
    debug(`MaxCandidates for ${validatorMatchPackage} is defined in in config: ${value}`);
    return value;
  }

  if (['CONTENT'].includes(validatorMatchPackage)) {
    const value = 50;
    debug(`MaxCandidates for ${validatorMatchPackage} is defined in in config: ${value}`);
    return value;
  }

  if (['CONTENTALT'].includes(validatorMatchPackage)) {
    const value = 150;
    debug(`MaxCandidates for ${validatorMatchPackage} is defined in in config: ${value}`);
    return value;
  }


  debug(`MaxCandidates for ${validatorMatchPackage} uses environment variable`);
  return readEnvironmentVariable('MAX_CANDIDATES', {defaultValue: 25, format: v => Number(v)});
}

function generateThreshold(validatorMatchPackage) {
  debug(`Threshold for ${validatorMatchPackage} uses environment variable`);
  const name = usesDeprecatedThresholdVariable ? 'MATCHING_TRESHOLD' : 'MATCHING_THRESHOLD';
  return readEnvironmentVariable(name, {defaultValue: 0.8999, format: v => Number(v)});
}

function generatePreValidationFixOptions() {
  if (recordType === 'bib') {
    return fixes.BIB_PREVALIDATION_FIX_SETTINGS;
  }

  // No preValidationFix for aut-names
  if (recordType === 'autname') {
    return {};
  }

  throw new Error(`Unsupported record type ${recordType}`);
}

function generatePostMergeFixOptions() {
  if (recordType === 'bib') {
    return fixes.BIB_POSTMERGE_FIX_SETTINGS;
  }
  if (recordType === 'autname') {
    return {};
  }
  throw new Error(`Unsupported record type ${recordType}`);
}

function generatePreImportFixOptions() {
  if (recordType === 'bib') {
    return fixes.BIB_PREIMPORT_FIX_SETTINGS;
  }

  if (recordType === 'autname') {
    return fixes.BIB_PREIMPORT_FIX_SETTINGS;
  }

  throw new Error(`Unsupported record type ${recordType}`);
}

function generateStrategy(validatorMatchPackage) {
  if (recordType === 'bib') {
    if (['IDS'].includes(validatorMatchPackage)) {
      return [
        matchDetection.features.bib.melindaId(),
        matchDetection.features.bib.allSourceIds()
      ];
    }

    // We could have differing strategy for STANDARD_IDS
    // Let's not run title in strategy when we found the candidates through standard_ids search

    if (['STANDARD_IDS'].includes(validatorMatchPackage)) {
      return [
        matchDetection.features.bib.hostComponent(),
        matchDetection.features.bib.isbn(),
        matchDetection.features.bib.issn(),
        matchDetection.features.bib.publisherNumber(),
        matchDetection.features.bib.otherStandardIdentifier(),
        // Let's not use the same title matchDetection here
        //matchDetection.features.bib.title(),
        matchDetection.features.bib.authors(),
        // We probably should have some leeway here for notated music as BK etc.
        matchDetection.features.bib.recordType(),
        // Use publicationTimeAllowConsYearsMulti to
        //  - ignore one year differences in publicationTime
        //  - extract publicationTimes from f008, f26x and reprint notes in f500
        //  - do not substract points for mismatching (normal) publicationTime, if there's a match between
        //       normal publicationTime and a reprintPublication time
        matchDetection.features.bib.publicationTimeAllowConsYearsMulti(),
        matchDetection.features.bib.language(),
        matchDetection.features.bib.bibliographicLevel()
      ];
    }

    if (['CONTENT', 'CONTENTALT'].includes(validatorMatchPackage)) {
      return [
        matchDetection.features.bib.hostComponent(),
        matchDetection.features.bib.isbn(),
        matchDetection.features.bib.issn(),
        matchDetection.features.bib.publisherNumber(),
        matchDetection.features.bib.otherStandardIdentifier(),
        matchDetection.features.bib.title(),
        matchDetection.features.bib.authors(),
        matchDetection.features.bib.recordType(),
        matchDetection.features.bib.publicationTime(),
        matchDetection.features.bib.language(),
        matchDetection.features.bib.bibliographicLevel()
      ];
    }
    throw new Error('Unsupported match validation package');
  }

  if (recordType === 'autname') {
    return undefined;
  }

  throw new Error(`Unsupported record type ${recordType}`);

}


function generateSearchSpec(validatorMatchPackage) {
  if (recordType === 'bib') {
    if (['IDS'].includes(validatorMatchPackage)) {
      return [
        candidateSearch.searchTypes.bib.melindaId,
        candidateSearch.searchTypes.bib.sourceIds
      ];
    }

    if (['STANDARD_IDS'].includes(validatorMatchPackage)) {
      return [candidateSearch.searchTypes.bib.standardIdentifiers];
    }

    if (['CONTENT'].includes(validatorMatchPackage)) {
      return [
        candidateSearch.searchTypes.bib.hostComponents,
        //candidateSearch.searchTypes.bib.titleAuthor,
        candidateSearch.searchTypes.bib.title
      ];
    }
    if (['CONTENTALT'].includes(validatorMatchPackage)) {
      return [
        candidateSearch.searchTypes.bib.hostComponents,
        // titleAuthorYearAlternates searches for matchCandidates
        // with alternate queries, starting from more tight searches
        candidateSearch.searchTypes.bib.titleAuthorYearAlternates
      ];

    }
    throw new Error('Unsupported match validation package');
  }

  if (recordType === 'autname') {
    return undefined;
  }

  throw new Error(`Unsupported record type ${recordType}`);
}
