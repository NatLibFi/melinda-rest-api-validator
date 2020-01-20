
import {Utils} from '@natlibfi/melinda-commons';

const {readEnvironmentVariable, parseBoolean} = Utils;

// Poll variables
export const POLL_RABBIT = parseBoolean(readEnvironmentVariable('POLL_RABBIT', {defaultValue: 0}));
export const POLL_WAIT_TIME = readEnvironmentVariable('POLL_WAIT_TIME', {defaultValue: 1000});

// Rabbit variables
export const AMQP_URL = JSON.parse(readEnvironmentVariable('AMQP_URL'));

// Mongo variables
export const MONGO_URI = readEnvironmentVariable('MONGO_URI', {defaultValue: 'mongodb://localhost:27017/db'});

// SRU variables
export const SRU_URL_BIB = readEnvironmentVariable('SRU_URL_BIB');
export const SRU_URL_BIBPRV = readEnvironmentVariable('SRU_URL_BIBPRV');
