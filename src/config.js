
import {parseBoolean} from '@natlibfi/melinda-commons';
import {readEnvironmentVariable} from '@natlibfi/melinda-backend-commons';
import {candidateSearch, matchDetection} from '@natlibfi/melinda-record-matching';
import {fixes} from '@natlibfi/melinda-rest-api-commons';
import createDebugLogger from 'debug';

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
const matchFailuresAsNew = readEnvironmentVariable('MATCH_FAILURES_AS_NEW', {defaultValue: false, format: v => parseBoolean(v)});

// We could have also settings matchValidation and merge here

export const validatorOptions = {
  recordType,
  preValidationFixOptions: generatePreValidationFixOptions(),
  postMergeFixOptions: generatePostMergeFixOptions(),
  preImportFixOptions: generatePreImportFixOptions(),
  sruUrl: readEnvironmentVariable('SRU_URL'),
  matchOptionsList: generateMatchOptionsList(),
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
      treshold: generateThreshold(validatorMatchPackage),
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
  return readEnvironmentVariable('MATCHING_TRESHOLD', {defaultValue: 0.9, format: v => Number(v)});
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
