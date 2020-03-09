
import {Utils} from '@natlibfi/melinda-commons';

const {readEnvironmentVariable, parseBoolean} = Utils;

// Poll variables
export const POLL_REQUEST = readEnvironmentVariable('POLL_REQUEST', {defaultValue: 0, format: v => parseBoolean(v)});
export const POLL_WAIT_TIME = readEnvironmentVariable('POLL_WAIT_TIME', {defaultValue: 1000});

// Amqp variables to priority
export const AMQP_URL = readEnvironmentVariable('AMQP_URL', {defaultValue: 'amqp://127.0.0.1:5672/'});

// Mongo variables to bulk
export const MONGO_URI = readEnvironmentVariable('MONGO_URI', {defaultValue: 'mongodb://127.0.0.1:27017/db'});

// SRU variables
export const SRU_URL_BIB = readEnvironmentVariable('SRU_URL_BIB');
