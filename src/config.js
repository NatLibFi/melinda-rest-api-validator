
import {Utils} from '@natlibfi/melinda-commons';

const {readEnvironmentVariable} = Utils;

export const PRIORITY = Boolean(readEnvironmentVariable('PRIORITY', {defaultValue: 0}));

export const AMQP_URL = JSON.parse(readEnvironmentVariable('AMQP_URL'));

export const MONGO_URI = readEnvironmentVariable('MONGO_URI', {defaultValue: 'mongodb://localhost:27017/db'});

export const SRU_URL_BIB = readEnvironmentVariable('SRU_URL_BIB');
export const SRU_URL_BIBPRV = readEnvironmentVariable('SRU_URL_BIBPRV');
