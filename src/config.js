
import {parseBoolean} from '@natlibfi/melinda-commons';
import {readEnvironmentVariable} from '@natlibfi/melinda-backend-commons';
import {candidateSearch, matchDetection} from '@natlibfi/melinda-record-matching';
import {format} from '@natlibfi/melinda-rest-api-commons';
import createDebugLogger from 'debug';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:config');
//const debugData = debug.extend('data');

// Poll variables
export const pollRequest = readEnvironmentVariable('POLL_REQUEST', {defaultValue: 0, format: v => parseBoolean(v)});
export const pollWaitTime = readEnvironmentVariable('POLL_WAIT_TIME', {defaultValue: 1000});

// Amqp variables to priority
export const amqpUrl = readEnvironmentVariable('AMQP_URL', {defaultValue: 'amqp://127.0.0.1:5672/'});

// Mongo variables to bulk
export const mongoUri = readEnvironmentVariable('MONGO_URI', {defaultValue: 'mongodb://127.0.0.1:27017/db'});

const recordType = readEnvironmentVariable('RECORD_TYPE');

export const splitterOptions = {
  // failBulkError: fail processing whole bulk of records if there's error on serializing a record
  failBulkOnError: readEnvironmentVariable('FAIL_BULK_ON_ERROR', {defaultValue: 1, format: v => parseBoolean(v)}),
  // keepSplitterReport: ALL/NONE/ERROR
  keepSplitterReport: readEnvironmentVariable('KEEP_SPLITTER_REPORT', {defaultValue: 'ERROR'})
};

const validatorMatchPackages = readEnvironmentVariable('VALIDATOR_MATCH_PACKAGES', {defaultValue: 'IDS,CONTENT'}).split(',');

export const validatorOptions = {
  formatOptions: generateFormatOptions(),
  sruUrl: readEnvironmentVariable('SRU_URL'),
  matchOptionsList: generateMatchOptionsList()
};

function generateMatchOptionsList() {
  return validatorMatchPackages.map(matchPackage => generateMatchOptions(matchPackage));
}

function generateMatchOptions(validatorMatchPackage) {
  return {
    matchPackageName: validatorMatchPackage,
    maxMatches: generateMaxMatches(validatorMatchPackage),
    maxCandidates: generateMaxCandidates(validatorMatchPackage),
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
  debug(`MaxMatches for ${validatorMatchPackage} uses environment variable`);
  return readEnvironmentVariable('MAX_MATCHES', {defaultValue: 1, format: v => Number(v)});
}

function generateMaxCandidates(validatorMatchPackage) {
  debug(`MaxCandidates for ${validatorMatchPackage} uses environment variable`);
  return readEnvironmentVariable('MAX_CANDIDATES', {defaultValue: 25, format: v => Number(v)});
}

function generateThreshold(validatorMatchPackage) {
  debug(`Threshold for ${validatorMatchPackage} uses environment variable`);
  return readEnvironmentVariable('MATCHING_TRESHOLD', {defaultValue: 0.9, format: v => Number(v)});
}


function generateFormatOptions() {
  if (recordType === 'bib') {
    return format.BIB_FORMAT_SETTINGS;
  }

  throw new Error('Unsupported record type');
}

function generateStrategy(validatorMatchPackage) {
  if (recordType === 'bib') {
    if (validatorMatchPackage === 'IDS') {
      return [
        matchDetection.features.bib.melindaId(),
        matchDetection.features.bib.allSourceIds()
      ];
    }
    if (validatorMatchPackage === 'CONTENT') {
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

  throw new Error('Unsupported record type');
}


function generateSearchSpec(validatorMatchPackage) {
  if (recordType === 'bib') {
    if (validatorMatchPackage === 'IDS') {
      return [
        candidateSearch.searchTypes.bib.melindaId,
        candidateSearch.searchTypes.bib.sourceIds
      ];
    }

    if (validatorMatchPackage === 'CONTENT') {
      return [
        candidateSearch.searchTypes.bib.hostComponents,
        candidateSearch.searchTypes.bib.standardIdentifiers,
        candidateSearch.searchTypes.bib.title
      ];
    }
    throw new Error('Unsupported match validation package');
  }

  throw new Error('Unsupported record type');
}
