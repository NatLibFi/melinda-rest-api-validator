import {getSidsFromRecord, getSubfieldValues} from '../../utils.js';

// Matches a melinda-id like "FI-MELINDA123456789" (optional whitespace after the prefix)
const MELINDA_ID_VALUE_REGEX = /^FI-MELINDA\s*(\d+)$/u;

// Encoding level (LDR/17) preference: index 0 = best, higher index = worse
const ENCODING_LEVEL_PREFERENCE = [' ', '1', '3', '4', '5', '2', '7', 'u', 'z', '8'];

// 594 $5 values that mark a 594 field as a prepublication level source
const PREPUB_594_SOURCES = ['FENNI', 'FIKKA', 'VIOLA'];


/**
 * Compute the sort key value for a given match selector rule.
 * @param {string} ruleName - One of KNOWN_MATCH_SELECTOR_RULES
 * @param {MarcRecord} incomingRecord - The incoming record
 * @param {MarcRecord} candidateRecord - The candidate record
 * @returns {number|null} The key value. null means "this rule doesn't apply" (neutral).
 */
export function computeRuleKey(ruleName, incomingRecord, candidateRecord) {
  switch (ruleName) {
    case 'MELINDA_ID':
      return computeMelindaIdKey(incomingRecord, candidateRecord);
    case 'LOCAL_SID':
      return computeLocalSidKey(incomingRecord, candidateRecord);
    case 'SAME_LOW':
      return computeSameLowKey(incomingRecord, candidateRecord);
    case 'NAT_BIB':
      return computeNatBibKey(candidateRecord);
    case 'LOW_COUNT':
      return computeLowCountKey(candidateRecord);
    case 'ENCODING_LEVEL':
      return computeEncodingLevelKey(candidateRecord);
    case 'PREPUB_LEVEL':
      return computePrepubLevelKey(candidateRecord);
    default:
      throw new Error(`Unknown match selector rule: ${ruleName}`);
  }
}


function getMelindaIdFromRecord(record) {
  const f035s = record.get(/^035$/u);

  for (const field of f035s) {
    const values = getSubfieldValues(field, 'a').concat(getSubfieldValues(field, 'z'));

    for (const value of values) {
      const match = value && value.match(MELINDA_ID_VALUE_REGEX);
      if (match) {
        return match[1];
      }
    }
  }

  return null;
}

// Compares the melinda-ids (035 $a/$z with FI-MELINDA prefix) of incoming vs candidate.
// 1 = same melinda-id, 0 = different, null = either record has no melinda-id.
function computeMelindaIdKey(incomingRecord, candidateRecord) {
  const incomingId = getMelindaIdFromRecord(incomingRecord);
  if (incomingId === null) {
    return null;
  }

  const candidateId = getMelindaIdFromRecord(candidateRecord);
  if (candidateId === null) {
    return null;
  }

  return incomingId === candidateId ? 1 : 0;
}

// Compares local SIDs ($b + $c pairs) of incoming vs candidate.
// getSidsFromRecord returns "(b)c" strings (only from fields with exactly one $b and one $c),
// so an exact string match means same $b AND same $c.
// 1 = shared local SID, 0 = no overlap, null = either record has no (valid) SID fields.
function computeLocalSidKey(incomingRecord, candidateRecord) {
  const incomingSids = getSidsFromRecord(incomingRecord);
  if (incomingSids.length === 0) {
    return null;
  }

  const candidateSids = getSidsFromRecord(candidateRecord);
  if (candidateSids.length === 0) {
    return null;
  }

  return incomingSids.some(sid => candidateSids.includes(sid)) ? 1 : 0;
}

function getLowValues(record) {
  const fLOWs = record.get(/^LOW$/u);
  return [].concat(...fLOWs.map(field => getSubfieldValues(field, 'a')));
}

// Compares LOW $a values of incoming vs candidate.
// 1 = at least one shared LOW $a value, 0 = no overlap, null = either record has no LOW $a values.
function computeSameLowKey(incomingRecord, candidateRecord) {
  const incomingLows = getLowValues(incomingRecord);
  if (incomingLows.length === 0) {
    return null;
  }

  const candidateLows = getLowValues(candidateRecord);
  if (candidateLows.length === 0) {
    return null;
  }

  return incomingLows.some(low => candidateLows.includes(low)) ? 1 : 0;
}

// Candidate property: national bibliography record (042 $a = finb or finbd).
// 1 = national bib, 0 = not. Never null.
function computeNatBibKey(candidateRecord) {
  const f042s = candidateRecord.get(/^042$/u);
  return f042s.some(field => {
    const values = getSubfieldValues(field, 'a');
    return values.includes('finb') || values.includes('finbd');
  }) ? 1 : 0;
}

// Candidate property: number of LOW fields. Returns the count (>= 0). Never null.
function computeLowCountKey(candidateRecord) {
  return candidateRecord.get(/^LOW$/u).length;
}

// Candidate property: encoding level (leader position 17) mapped to its index in the
// preference array. Smaller index = better (sorted ASC).
// null if the leader is too short or the character is not in the preference array.
function computeEncodingLevelKey(candidateRecord) {
  const leader = candidateRecord.leader;
  if (!leader || leader.length < 18) {
    return null;
  }

  const index = ENCODING_LEVEL_PREFERENCE.indexOf(leader[17]);
  return index === -1 ? null : index;
}

function isPrepubSourceField(field) {
  // 500 always counts; 594 only when $5 is FENNI, FIKKA or VIOLA
  if (field.tag === '500') {
    return true;
  }

  return getSubfieldValues(field, '5').some(code => PREPUB_594_SOURCES.includes(code));
}

// Maps a 5XX $a text to its prepublication level (1 = best, 3 = worst), or null if no match.
function getPrepubLevelFromText(text) {
  if (/^Koneellisesti tuotettu tietue/u.test(text)) {
    return 1;
  }

  if (/^tarkistettu ennakkotieto/ui.test(text)) {
    return 2;
  }

  if (/^ennakkotieto(?:$|[. ])/ui.test(text) || /^EI VIELÄ ILMESTYNYT/u.test(text)) {
    return 3;
  }

  return null;
}

// Candidate property: prepublication level from 500 $a and 594 $a (with $5 = FENNI/FIKKA/VIOLA).
// Returns the best (smallest) level found (1, 2 or 3, sorted ASC), or null if no matching 5XX field.
function computePrepubLevelKey(candidateRecord) {
  const prepubFields = candidateRecord.get(/^500$/u)
    .concat(candidateRecord.get(/^594$/u))
    .filter(isPrepubSourceField);

  let bestLevel = null;

  for (const field of prepubFields) {
    for (const text of getSubfieldValues(field, 'a')) {
      const level = getPrepubLevelFromText(text);
      if (level !== null && (bestLevel === null || level < bestLevel)) {
        bestLevel = level;
      }
    }
  }

  return bestLevel;
}
