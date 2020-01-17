import {Utils} from '@natlibfi/melinda-commons';

const {createLogger} = Utils;
const logger = createLogger(); // eslint-disable-line no-unused-vars

export function logError(err) {
	if (err === 'SIGINT') {
		logger.log('error', err);
	} else {
		logger.log('error', 'stack' in err ? err.stack : err);
		if (err.validationResults) {
			logger.log('error', `ValidationResults: ${JSON.stringify(err.validationResults)}`);
		}
	}
}
