import httpStatus from 'http-status';
import {Error as ValidationError} from '@natlibfi/melinda-commons';

import createDebugLogger from 'debug';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:own-authorization');
const debugData = debug.extend('data');

export default ({ownTags, incomingRecord, existingRecord, recordMetadata, validate}) => {

  // Skip this validation if validate: false
  if (validate === false) {
    return 'skipped';
  }

  const lowTags = getLowTags();
  debugData(`OwnTags: ${ownTags}`);
  debugData(`LowTags: ${lowTags}`);

  if (lowTags && ownTags && lowTags.some(t => !ownTags.includes(t))) { // eslint-disable-line functional/no-conditional-statement
    throw new ValidationError(httpStatus.FORBIDDEN, {message: 'Own authorization error', recordMetadata});
  }

  function getLowTags() {
    if (existingRecord) {
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

    return get(incomingRecord);

    // Get unique tags
    function get(record) {
      return record.get(/^LOW$/u)
        .map(f => f.subfields.find(sf => sf.code === 'a').value)
        .reduce((acc, v) => acc.includes(v) ? acc : acc.concat(v), []);
    }
  }
};
