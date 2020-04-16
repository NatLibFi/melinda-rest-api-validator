
import {Utils} from '@natlibfi/melinda-commons';

const {readEnvironmentVariable, parseBoolean} = Utils;

// Poll variables
export const pollRequest = readEnvironmentVariable('POLL_REQUEST', {defaultValue: 0, format: v => parseBoolean(v)});
export const pollWaitTime = readEnvironmentVariable('POLL_WAIT_TIME', {defaultValue: 1000});

// Amqp variables to priority
export const amqpUrl = readEnvironmentVariable('AMQP_URL', {defaultValue: 'amqp://127.0.0.1:5672/'});

// Mongo variables to bulk
export const mongoUri = readEnvironmentVariable('MONGO_URI', {defaultValue: 'mongodb://127.0.0.1:27017/db'});

// SRU variables
export const sruUrlBib = readEnvironmentVariable('SRU_URL_BIB');
