import httpStatus from 'http-status';
import {Error as ValidationError, Error as ApiError} from '@natlibfi/melinda-commons';
import {OPERATIONS} from '@natlibfi/melinda-rest-api-commons/dist/constants';

import createDebugLogger from 'debug';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:own-authorization');
const debugData = debug.extend('data');

export default ({ownTags, incomingRecord, existingRecord, recordMetadata, operation, validate}) => {

  // Skip this validation if validate: false
  if (validate === false) {
    return 'skipped';
  }

  const lowTags = getLowTags();
  debugData(`OwnTags: ${ownTags}`);
  debugData(`LowTags: ${lowTags}`);

  if (lowTags && ownTags && lowTags.some(t => !ownTags.includes(t))) {
    debug(`There's a difference including one or more non-authorized lows.`);
    throw new ValidationError(httpStatus.FORBIDDEN, {message: 'Own authorization error', recordMetadata});
  }
  debug(`There's are no differences including non-authorized lows.`);

  function getLowTags() {
    if (existingRecord) {
      debug(`We're running validateOwnChanges between incomingRecord and existingRecord for ${operation}`);

      const incomingTags = get(incomingRecord);
      const existingTags = get(existingRecord);
      debugData(`IncomingTags: ${incomingTags}`);
      debugData(`ExistingTags: ${existingTags}`);

      const additions = incomingTags.reduce((acc, tag) => existingTags.includes(tag) ? acc : acc.concat(tag), []);

      const removals = existingTags.reduce((acc, tag) => incomingTags.includes(tag) ? acc : acc.concat(tag), []);

      debugData(`Additions: ${additions}`);
      debugData(`Removals: ${removals}`);

      // Concat and remove duplicates
      return additions.concat(removals).reduce((acc, tag) => acc.includes(tag) ? acc : acc.concat(tag), []);
    }

    debug(`We're running validateOwnChanges just for incomingRecord for operation: ${operation}`);
    if (operation !== OPERATIONS.CREATE) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, {message: 'Missing existingRecord in validateOwnChanges'});
    }

    return get(incomingRecord);

    // Get unique tags
    function get(record) {
      return record.get(/^LOW$/u)
        .map(f => f.subfields.find(sf => sf.code === 'a').value)
        .reduce((acc, v) => acc.includes(v) ? acc : acc.concat(v), []);
    }
  }
};
