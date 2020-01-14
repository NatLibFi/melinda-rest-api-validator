
import {Utils} from '@natlibfi/melinda-commons';

const {readEnvironmentVariable} = Utils;

export const MONGO_URI = readEnvironmentVariable('MONGO_URI', {defaultValue: 'mongodb://localhost:27017/db'});

export const AMQP_URL = JSON.parse(readEnvironmentVariable('AMQP_URL'));
