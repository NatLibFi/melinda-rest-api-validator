import {computeRuleKey} from './match-selector-rules.js';

// Rules whose key values are sorted DESC (higher = better). All other rule keys are ASC.
// PROBABILITY is also DESC (handled separately since it is not a config rule).
export const DESC_RULES = new Set(['MELINDA_ID', 'LOCAL_SID', 'SAME_LOW', 'NAT_BIB', 'LOW_COUNT']);

const PROBABILITY_KEY = 'PROBABILITY';
const MATCH_SEQUENCE_KEY = 'MATCH_SEQUENCE';


/**
 * Sort candidates by the match selector rules (lexicographic multi-key sort).
 *
 * The keys are compared in this order: the active rules (in the given priority
 * order), then PROBABILITY (DESC), then MATCH_SEQUENCE (ASC). A key whose
 * computed value is null for either candidate is skipped (neutral).
 * Equivalent candidates keep their original relative order (stable sort).
 *
 * @param {MarcRecord} record - The incoming record
 * @param {Array} candidates - List of enriched valid candidates, each item:
 *   {candidate: {id, record}, probability, matchSequence, action, preference, message, ...}
 * @param {string[]} rules - List of rule names in priority order (from config)
 * @returns {Array} Sorted list (best to worst). Each item is the original candidate
 *   object with two fields added:
 *   - rank: int (1-based position)
 *   - keyValues: object mapping each key to its computed value (for debugging)
 */
export function sortCandidatesByRules(record, candidates, rules) {
  const keyNames = rules.concat([PROBABILITY_KEY, MATCH_SEQUENCE_KEY]);

  // Pre-compute all key values once so the comparator only does lookups
  for (const candidate of candidates) {
    candidate.keyValues = computeKeyValues(record, candidate, rules);
  }

  const sorted = [...candidates].sort((a, b) => compareCandidates(a, b, keyNames));

  sorted.forEach((candidate, index) => {
    candidate.rank = index + 1;
  });

  return sorted;
}


/**
 * Compute the keyValues object for one candidate.
 * @param {MarcRecord} record - The incoming record
 * @param {object} candidate - One candidate item (see sortCandidatesByRules)
 * @param {string[]} rules - Active rule names
 * @returns {object} Map of key name to computed value (number or null)
 */
function computeKeyValues(record, candidate, rules) {
  const keyValues = {};

  for (const ruleName of rules) {
    keyValues[ruleName] = computeRuleKey(ruleName, record, candidate.candidate.record);
  }

  keyValues[PROBABILITY_KEY] = candidate.probability;
  keyValues[MATCH_SEQUENCE_KEY] = candidate.matchSequence;

  return keyValues;
}


/**
 * Compare two candidates whose keyValues are already computed.
 * @param {object} a - Candidate with pre-computed keyValues
 * @param {object} b - Candidate with pre-computed keyValues
 * @param {string[]} keyNames - Key names in comparison order
 * @returns {number} Negative if a is better, positive if b is better, 0 if tied
 */
function compareCandidates(a, b, keyNames) {
  for (const keyName of keyNames) {
    const aValue = a.keyValues[keyName];
    const bValue = b.keyValues[keyName];

    if (aValue === bValue) {
      continue; // tied on this key
    }

    if (aValue === null || bValue === null) {
      continue; // rule doesn't apply to one side, treat as neutral
    }

    if (isDescending(keyName)) {
      return aValue > bValue ? -1 : 1;
    }

    return aValue < bValue ? -1 : 1;
  }

  return 0; // all keys tied, stable sort preserves original order
}


/**
 * Whether a key is compared DESC (higher = better).
 * @param {string} keyName - Key name (rule name, PROBABILITY or MATCH_SEQUENCE)
 * @returns {boolean}
 */
function isDescending(keyName) {
  return keyName === PROBABILITY_KEY || DESC_RULES.has(keyName);
}
