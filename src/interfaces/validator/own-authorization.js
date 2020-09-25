import httpStatus from 'http-status';
import {Error as ValidationError} from '@natlibfi/melinda-commons';

export default (ownTags, incomingRecord, existingRecord) => {
  const lowTags = getLowTags();

  if (lowTags.some(t => !ownTags.includes(t))) { // eslint-disable-line functional/no-conditional-statement
    throw new ValidationError(httpStatus.FORBIDDEN, 'Own authorization error');
  }

  function getLowTags() {
    if (existingRecord) {
      const incomingTags = get(incomingRecord);
      const existingTags = get(existingRecord);

      const additions = incomingTags.reduce((acc, tag) => existingTags.includes(tag) ? acc : acc.concat(tag), []);

      const removals = existingTags.reduce((acc, tag) => incomingTags.includes(tag) ? acc : acc.concat(tag), []);

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
