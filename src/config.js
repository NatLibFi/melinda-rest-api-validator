
import {parseBoolean} from '@natlibfi/melinda-commons';
import {readEnvironmentVariable} from '@natlibfi/melinda-backend-commons';
import {candidateSearch, matchDetection} from '@natlibfi/melinda-record-matching';
import {format} from '@natlibfi/melinda-rest-api-commons';

// Poll variables
export const pollRequest = readEnvironmentVariable('POLL_REQUEST', {defaultValue: 0, format: v => parseBoolean(v)});
export const pollWaitTime = readEnvironmentVariable('POLL_WAIT_TIME', {defaultValue: 1000});

// Amqp variables to priority
export const amqpUrl = readEnvironmentVariable('AMQP_URL', {defaultValue: 'amqp://127.0.0.1:5672/'});

// Mongo variables to bulk
export const mongoUri = readEnvironmentVariable('MONGO_URI', {defaultValue: 'mongodb://127.0.0.1:27017/db'});

const recordType = readEnvironmentVariable('RECORD_TYPE');

export const validatorOptions = {
  formatOptions: generateFormatOptions(),
  sruUrl: readEnvironmentVariable('SRU_URL'),
  matchOptions: {
    maxMatches: readEnvironmentVariable('MAX_MATCHES', {defaultValue: 1, format: v => Number(v)}),
    maxCandidates: readEnvironmentVariable('MAX_CANDIDATES', {defaultValue: 25, format: v => Number(v)}),
    search: {
      url: readEnvironmentVariable('SRU_URL'),
      searchSpec: generateSearchSpec()
    },
    detection: {
      treshold: readEnvironmentVariable('MATCHING_TRESHOLD', {defaultValue: 0.9, format: v => Number(v)}),
      strategy: generateStrategy()
    }
  }
};

function generateFormatOptions() {
  if (recordType === 'bib') {
    return format.BIB_FORMAT_SETTINGS;
  }

  throw new Error('Unsupported record type');
}

function generateStrategy() {
  if (recordType === 'bib') {
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

  throw new Error('Unsupported record type');
}

function generateSearchSpec() {
  if (recordType === 'bib') {
    return [
      candidateSearch.searchTypes.bib.hostComponents,
      candidateSearch.searchTypes.bib.standardIdentifiers,
      candidateSearch.searchTypes.bib.title
    ];
  }

  throw new Error('Unsupported record type');
}
