import assert from 'node:assert';
import {describe, it} from 'node:test';
import {MarcRecord} from '@natlibfi/marc-record';
import {sortCandidatesByRules} from './match-selector.js';

MarcRecord.setValidationOptions({subfieldValues: false});

const LEADER = '00000nam a2200000 a 4500';

const ALL_RULES = [
  'MELINDA_ID',
  'LOCAL_SID',
  'SAME_LOW',
  'NAT_BIB',
  'LOW_COUNT',
  'ENCODING_LEVEL',
  'PREPUB_LEVEL'
];


function titleField(a) {
  return {tag: '245', ind1: '1', ind2: ' ', subfields: [{code: 'a', value: a}]};
}

function makeRecord(fields, leader = LEADER) {
  // MarcRecord requires at least one field, so always include a 245
  return new MarcRecord({leader, fields: [titleField('foo.'), ...fields]}, {subfieldValues: false});
}

function melinda035(value) {
  return {tag: '035', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value}]};
}

function sidField(b, c) {
  return {tag: 'SID', ind1: ' ', ind2: ' ', subfields: [{code: 'c', value: c}, {code: 'b', value: b}]};
}

function lowField(a) {
  return {tag: 'LOW', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: a}]};
}

function tagField(tag, subfields, value) {
  return {tag, ind1: ' ', ind2: ' ', subfields, value};
}

function natBib042() {
  return tagField('042', [{code: 'a', value: 'finb'}]);
}

function prepub500(text) {
  return tagField('500', [{code: 'a', value: text}]);
}

// 18-char leader with the given char at encoding level position (index 17)
function leaderWithEncodingLevel(char) {
  return '00000nam a2200000' + char;
}

function makeCandidate(id, fields, {probability = 1, matchSequence = 0} = {}) {
  return {
    candidate: {id, record: makeRecord(fields)},
    probability,
    matchSequence,
    action: 'MATCH',
    preference: 'PREF',
    message: ''
  };
}

function ids(sorted) {
  return sorted.map(candidate => candidate.candidate.id);
}

const INCOMING_WITH_MELINDA = makeRecord([
  melinda035('FI-MELINDA123456789'),
  sidField('BIB', '000019640')
]);

const INCOMING_FULL = makeRecord([
  melinda035('FI-MELINDA123456789'),
  sidField('BIB', '000019640'),
  lowField('123')
]);

const INCOMING_PLAIN = makeRecord([]);


describe('sortCandidatesByRules', () => {
  describe('basic sorting', () => {
    it('sorts by the first rule (1 > 0), with a null skipping to the next key', () => {
      const candidates = [
        // c2 has one LOW field so it beats c3 (LOW_COUNT 1 vs 0) on the second key
        makeCandidate('c2', [melinda035('FI-MELINDA999999999'), lowField('456')]),
        makeCandidate('c1', [melinda035('FI-MELINDA123456789')]),
        makeCandidate('c3', [])
      ];

      const sorted = sortCandidatesByRules(
        INCOMING_WITH_MELINDA, candidates, ['MELINDA_ID', 'LOW_COUNT']);

      // c1 (melinda 1) first; c3 (melinda null) skips to LOW_COUNT and loses to c2
      assert.deepStrictEqual(ids(sorted), ['c1', 'c2', 'c3']);
    });

    it('lets the second rule decide when the first is tied (all null)', () => {
      // Incoming has no melinda-id, so MELINDA_ID is null for everyone
      const candidates = [
        makeCandidate('c2', []),
        makeCandidate('c3', []),
        makeCandidate('c1', [natBib042()])
      ];

      const sorted = sortCandidatesByRules(INCOMING_PLAIN, candidates, ['MELINDA_ID', 'NAT_BIB']);

      assert.deepStrictEqual(ids(sorted), ['c1', 'c2', 'c3']);
    });

    it('orders candidates across multiple rules', () => {
      const candidates = [
        makeCandidate('c3', [melinda035('FI-MELINDA999999999'), sidField('BIB', '000099999')]),
        makeCandidate('c1', [melinda035('FI-MELINDA123456789')]),
        makeCandidate('c2', [melinda035('FI-MELINDA999999999'), sidField('BIB', '000019640')]),
        makeCandidate('c4', [sidField('BIB', '000019640')])
      ];

      const sorted = sortCandidatesByRules(
        INCOMING_WITH_MELINDA, candidates, ['MELINDA_ID', 'LOCAL_SID', 'NAT_BIB']);

      // c1: melinda 1. c2 and c4 tied (sid 1, nat_bib 0, stable). c3: sid 0.
      assert.deepStrictEqual(ids(sorted), ['c1', 'c2', 'c4', 'c3']);
    });

    it('uses PROBABILITY (DESC) as tie-break when all rules are null or tied', () => {
      const candidates = [
        makeCandidate('c1', [], {probability: 0.5}),
        makeCandidate('c2', [], {probability: 0.9}),
        makeCandidate('c3', [], {probability: 0.7})
      ];

      const sorted = sortCandidatesByRules(INCOMING_PLAIN, candidates, ALL_RULES);

      assert.deepStrictEqual(ids(sorted), ['c2', 'c3', 'c1']);
    });

    it('uses MATCH_SEQUENCE (ASC) as the final tie-break', () => {
      const candidates = [
        makeCandidate('c1', [], {matchSequence: 3}),
        makeCandidate('c2', [], {matchSequence: 1}),
        makeCandidate('c3', [], {matchSequence: 2})
      ];

      const sorted = sortCandidatesByRules(INCOMING_PLAIN, candidates, ALL_RULES);

      assert.deepStrictEqual(ids(sorted), ['c2', 'c3', 'c1']);
    });
  });

  describe('null-skip behavior', () => {
    it('skips a null first key and lets the second key decide in favor of the null candidate', () => {
      // a: melinda null, sid 1. b: melinda 0, sid 0.
      const candidates = [
        makeCandidate('b', [melinda035('FI-MELINDA999999999'), sidField('BIB', '000099999')]),
        makeCandidate('a', [sidField('BIB', '000019640')])
      ];

      const sorted = sortCandidatesByRules(
        INCOMING_WITH_MELINDA, candidates, ['MELINDA_ID', 'LOCAL_SID']);

      assert.deepStrictEqual(ids(sorted), ['a', 'b']);
    });

    it('skips a key when both candidates are null and uses the next key', () => {
      // Both have no LOW fields (SAME_LOW null); NAT_BIB decides.
      const candidates = [
        makeCandidate('b', []),
        makeCandidate('a', [natBib042()])
      ];

      const sorted = sortCandidatesByRules(INCOMING_PLAIN, candidates, ['SAME_LOW', 'NAT_BIB']);

      assert.deepStrictEqual(ids(sorted), ['a', 'b']);
    });

    it('treats null as neutral, not as the worst value', () => {
      // b: melinda null, sid 1. a: melinda 1, sid null.
      // Every comparison is skipped, so the stable original order [b, a] is kept.
      const candidates = [
        makeCandidate('b', [sidField('BIB', '000019640')]),
        makeCandidate('a', [melinda035('FI-MELINDA123456789')])
      ];

      const sorted = sortCandidatesByRules(
        INCOMING_WITH_MELINDA, candidates, ['MELINDA_ID', 'LOCAL_SID']);

      assert.deepStrictEqual(ids(sorted), ['b', 'a']);
    });

    it('a null candidate is not treated as a 0 or a winner on the next key', () => {
      // a: melinda 0, nat_bib 0. b: melinda null, nat_bib 1.
      // Rule 0 is skipped (null vs 0), then b wins on NAT_BIB.
      const candidates = [
        makeCandidate('a', [melinda035('FI-MELINDA999999999')]),
        makeCandidate('b', [natBib042()])
      ];

      const sorted = sortCandidatesByRules(INCOMING_WITH_MELINDA, candidates, ['MELINDA_ID', 'NAT_BIB']);

      assert.deepStrictEqual(ids(sorted), ['b', 'a']);
    });
  });

  describe('DESC vs ASC', () => {
    it('sorts DESC rules (NAT_BIB) with the higher value first', () => {
      const candidates = [
        makeCandidate('b', []),
        makeCandidate('a', [natBib042()])
      ];

      const sorted = sortCandidatesByRules(INCOMING_PLAIN, candidates, ['NAT_BIB']);

      assert.deepStrictEqual(ids(sorted), ['a', 'b']);
    });

    it('sorts ASC rules (ENCODING_LEVEL) with the lower value first', () => {
      // '1' -> preference index 1, '8' -> preference index 9
      const a = makeCandidate('a', [], undefined);
      a.candidate.record = makeRecord([], leaderWithEncodingLevel('1'));
      const b = makeCandidate('b', [], undefined);
      b.candidate.record = makeRecord([], leaderWithEncodingLevel('8'));
      const candidates = [b, a];

      const sorted = sortCandidatesByRules(INCOMING_PLAIN, candidates, ['ENCODING_LEVEL']);

      assert.deepStrictEqual(ids(sorted), ['a', 'b']);
    });

    it('sorts ASC rules (PREPUB_LEVEL) with the lower level first', () => {
      const candidates = [
        makeCandidate('b', [prepub500('Ennakkotieto.')]),
        makeCandidate('a', [prepub500('Koneellisesti tuotettu tietue')])
      ];

      const sorted = sortCandidatesByRules(INCOMING_PLAIN, candidates, ['PREPUB_LEVEL']);

      assert.deepStrictEqual(ids(sorted), ['a', 'b']);
    });
  });

  describe('rank and keyValues', () => {
    it('assigns 1-based sequential ranks after sorting', () => {
      const candidates = [
        makeCandidate('c1', [], {probability: 0.5}),
        makeCandidate('c2', [], {probability: 0.9}),
        makeCandidate('c3', [], {probability: 0.7})
      ];

      const sorted = sortCandidatesByRules(INCOMING_PLAIN, candidates, ALL_RULES);

      assert.deepStrictEqual(sorted.map(candidate => candidate.rank), [1, 2, 3]);
    });

    it('computes keyValues for all active rules plus PROBABILITY and MATCH_SEQUENCE', () => {
      const candidates = [
        makeCandidate('c1', [
          melinda035('FI-MELINDA123456789'),
          sidField('BIB', '000019640'),
          lowField('123'),
          natBib042()
        ], {probability: 0.9, matchSequence: 7})
      ];

      const sorted = sortCandidatesByRules(INCOMING_FULL, candidates, ALL_RULES);

      assert.deepStrictEqual(sorted[0].keyValues, {
        MELINDA_ID: 1,
        LOCAL_SID: 1,
        SAME_LOW: 1,
        NAT_BIB: 1,
        LOW_COUNT: 1,
        // The default leader has ' ' at position 17, which is preference index 0
        ENCODING_LEVEL: 0,
        PREPUB_LEVEL: null,
        PROBABILITY: 0.9,
        MATCH_SEQUENCE: 7
      });
    });

    it('annotates the original candidate objects and returns a new array', () => {
      const candidates = [
        makeCandidate('c1', [melinda035('FI-MELINDA123456789')]),
        makeCandidate('c2', [melinda035('FI-MELINDA999999999')])
      ];

      const sorted = sortCandidatesByRules(INCOMING_WITH_MELINDA, candidates, ['MELINDA_ID']);

      assert.notStrictEqual(sorted, candidates);
      assert.strictEqual(sorted[0], candidates[0]);
      assert.strictEqual(sorted[1], candidates[1]);
      assert.ok('rank' in candidates[0]);
      assert.ok('keyValues' in candidates[0]);
    });
  });

  describe('stable sort', () => {
    it('preserves the original order when all keys are equivalent', () => {
      const candidates = [
        makeCandidate('c3', []),
        makeCandidate('c1', []),
        makeCandidate('c2', [])
      ];

      const sorted = sortCandidatesByRules(INCOMING_PLAIN, candidates, ALL_RULES);

      assert.deepStrictEqual(ids(sorted), ['c3', 'c1', 'c2']);
    });

    it('keeps tied candidates in original order among non-tied ones', () => {
      const candidates = [
        makeCandidate('c1', [], {probability: 0.5}),
        makeCandidate('c2', [], {probability: 0.5}),
        makeCandidate('c3', [], {probability: 0.9})
      ];

      const sorted = sortCandidatesByRules(INCOMING_PLAIN, candidates, ALL_RULES);

      assert.deepStrictEqual(ids(sorted), ['c3', 'c1', 'c2']);
    });
  });

  describe('edge cases', () => {
    it('returns an empty array for an empty candidate list', () => {
      assert.deepStrictEqual(sortCandidatesByRules(INCOMING_PLAIN, [], ALL_RULES), []);
    });

    it('assigns rank 1 to a single candidate', () => {
      const candidates = [makeCandidate('c1', [melinda035('FI-MELINDA123456789')])];

      const sorted = sortCandidatesByRules(INCOMING_WITH_MELINDA, candidates, ALL_RULES);

      assert.deepStrictEqual(ids(sorted), ['c1']);
      assert.strictEqual(sorted[0].rank, 1);
    });

    it('uses only PROBABILITY and MATCH_SEQUENCE when rules is empty', () => {
      const candidates = [
        makeCandidate('c1', [], {probability: 0.5, matchSequence: 2}),
        makeCandidate('c2', [], {probability: 0.9, matchSequence: 5}),
        makeCandidate('c3', [], {probability: 0.9, matchSequence: 1})
      ];

      const sorted = sortCandidatesByRules(INCOMING_PLAIN, candidates, []);

      assert.deepStrictEqual(ids(sorted), ['c3', 'c2', 'c1']);
      assert.deepStrictEqual(Object.keys(sorted[0].keyValues), ['PROBABILITY', 'MATCH_SEQUENCE']);
    });
  });
});
