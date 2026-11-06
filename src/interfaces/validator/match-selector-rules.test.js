import assert from 'node:assert';
import {describe, it} from 'node:test';
import {MarcRecord} from '@natlibfi/marc-record';
import {computeRuleKey} from './match-selector-rules.js';

MarcRecord.setValidationOptions({subfieldValues: false});

const LEADER = '00000nam a2200000 a 4500';

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

// 18-char leader with the given char at encoding level position (index 17)
function leaderWithEncodingLevel(char) {
  return '00000nam a2200000' + char;
}

describe('computeRuleKey', () => {
  describe('MELINDA_ID', () => {
    it('returns 1 when both have the same melinda-id', () => {
      const incoming = makeRecord([melinda035('FI-MELINDA123456789')]);
      const candidate = makeRecord([melinda035('FI-MELINDA123456789')]);

      assert.equal(computeRuleKey('MELINDA_ID', incoming, candidate), 1);
    });

    it('returns 1 when one id is in $z', () => {
      const incoming = makeRecord([
        {tag: '035', ind1: ' ', ind2: ' ', subfields: [{code: 'z', value: 'FI-MELINDA987654321'}]}
      ]);
      const candidate = makeRecord([melinda035('FI-MELINDA987654321')]);

      assert.equal(computeRuleKey('MELINDA_ID', incoming, candidate), 1);
    });

    it('returns 1 when there is whitespace after the FI-MELINDA prefix', () => {
      const incoming = makeRecord([melinda035('FI-MELINDA 123456789')]);
      const candidate = makeRecord([melinda035('FI-MELINDA123456789')]);

      assert.equal(computeRuleKey('MELINDA_ID', incoming, candidate), 1);
    });

    it('returns 0 when both have different melinda-ids', () => {
      const incoming = makeRecord([melinda035('FI-MELINDA123456789')]);
      const candidate = makeRecord([melinda035('FI-MELINDA999999999')]);

      assert.equal(computeRuleKey('MELINDA_ID', incoming, candidate), 0);
    });

    it('returns null when incoming has no melinda-id', () => {
      const incoming = makeRecord([]);
      const candidate = makeRecord([melinda035('FI-MELINDA123456789')]);

      assert.equal(computeRuleKey('MELINDA_ID', incoming, candidate), null);
    });

    it('returns null when candidate has no melinda-id', () => {
      const incoming = makeRecord([melinda035('FI-MELINDA123456789')]);
      const candidate = makeRecord([]);

      assert.equal(computeRuleKey('MELINDA_ID', incoming, candidate), null);
    });

    it('returns null when the 035 value does not look like a melinda-id', () => {
      const incoming = makeRecord([melinda035('12345')]);
      const candidate = makeRecord([melinda035('FI-MELINDA123456789')]);

      assert.equal(computeRuleKey('MELINDA_ID', incoming, candidate), null);
    });

    it('uses the first melinda-id found across multiple 035 fields', () => {
      const incoming = makeRecord([
        melinda035('111'),
        melinda035('FI-MELINDA222222222')
      ]);
      const candidate = makeRecord([
        melinda035('FI-MELINDA222222222'),
        melinda035('FI-MELINDA333333333')
      ]);

      assert.equal(computeRuleKey('MELINDA_ID', incoming, candidate), 1);
    });
  });

  describe('LOCAL_SID', () => {
    it('returns 1 when both share a local SID', () => {
      const incoming = makeRecord([sidField('BIB', '000019640')]);
      const candidate = makeRecord([sidField('BIB', '000019640')]);

      assert.equal(computeRuleKey('LOCAL_SID', incoming, candidate), 1);
    });

    it('returns 0 when both have SIDs but none shared', () => {
      const incoming = makeRecord([sidField('BIB', '000019640')]);
      const candidate = makeRecord([sidField('BIB', '000019641')]);

      assert.equal(computeRuleKey('LOCAL_SID', incoming, candidate), 0);
    });

    it('returns null when incoming has no SID fields', () => {
      const incoming = makeRecord([]);
      const candidate = makeRecord([sidField('BIB', '000019640')]);

      assert.equal(computeRuleKey('LOCAL_SID', incoming, candidate), null);
    });

    it('returns null when candidate has no SID fields', () => {
      const incoming = makeRecord([sidField('BIB', '000019640')]);
      const candidate = makeRecord([]);

      assert.equal(computeRuleKey('LOCAL_SID', incoming, candidate), null);
    });

    it('ignores invalid SID fields (wrong subfield counts)', () => {
      const invalid = {
        tag: 'SID',
        ind1: ' ',
        ind2: ' ',
        subfields: [
          {code: 'c', value: '1'},
          {code: 'c', value: '2'},
          {code: 'b', value: 'BIB'}
        ]
      };
      const incoming = makeRecord([invalid]);
      const candidate = makeRecord([sidField('BIB', '000019640')]);

      assert.equal(computeRuleKey('LOCAL_SID', incoming, candidate), null);
    });

    it('returns 1 when a later SID field overlaps with the candidate', () => {
      const incoming = makeRecord([
        sidField('BIB', '000000001'),
        sidField('BIB', '000000002')
      ]);
      const candidate = makeRecord([sidField('BIB', '000000002')]);

      assert.equal(computeRuleKey('LOCAL_SID', incoming, candidate), 1);
    });

    it('requires both $b and $c to match, not just $c', () => {
      const incoming = makeRecord([sidField('BIB', '000019640')]);
      const candidate = makeRecord([sidField('OTHER', '000019640')]);

      assert.equal(computeRuleKey('LOCAL_SID', incoming, candidate), 0);
    });
  });

  describe('SAME_LOW', () => {
    it('returns 1 when both share a LOW', () => {
      const incoming = makeRecord([lowField('123')]);
      const candidate = makeRecord([lowField('123')]);

      assert.equal(computeRuleKey('SAME_LOW', incoming, candidate), 1);
    });

    it('returns 0 when both have LOWs but none shared', () => {
      const incoming = makeRecord([lowField('123')]);
      const candidate = makeRecord([lowField('456')]);

      assert.equal(computeRuleKey('SAME_LOW', incoming, candidate), 0);
    });

    it('returns null when incoming has no LOW fields', () => {
      const incoming = makeRecord([]);
      const candidate = makeRecord([lowField('123')]);

      assert.equal(computeRuleKey('SAME_LOW', incoming, candidate), null);
    });

    it('returns null when candidate has no LOW fields', () => {
      const incoming = makeRecord([lowField('123')]);
      const candidate = makeRecord([]);

      assert.equal(computeRuleKey('SAME_LOW', incoming, candidate), null);
    });

    it('returns null when a LOW field has no $a subfield', () => {
      const noA = {tag: 'LOW', ind1: ' ', ind2: ' ', subfields: [{code: 'b', value: 'x'}]};
      const incoming = makeRecord([noA]);
      const candidate = makeRecord([lowField('123')]);

      assert.equal(computeRuleKey('SAME_LOW', incoming, candidate), null);
    });

    it('finds a match among multiple LOW fields', () => {
      const incoming = makeRecord([lowField('111'), lowField('222')]);
      const candidate = makeRecord([lowField('333'), lowField('222')]);

      assert.equal(computeRuleKey('SAME_LOW', incoming, candidate), 1);
    });
  });

  describe('NAT_BIB', () => {
    it('returns 1 when candidate has 042 $a = finb', () => {
      const incoming = makeRecord([]);
      const candidate = makeRecord([tagField('042', [{code: 'a', value: 'finb'}])]);

      assert.equal(computeRuleKey('NAT_BIB', incoming, candidate), 1);
    });

    it('returns 1 when candidate has 042 $a = finbd', () => {
      const incoming = makeRecord([]);
      const candidate = makeRecord([tagField('042', [{code: 'a', value: 'finbd'}])]);

      assert.equal(computeRuleKey('NAT_BIB', incoming, candidate), 1);
    });

    it('returns 0 when candidate has a 042 with another authority', () => {
      const incoming = makeRecord([]);
      const candidate = makeRecord([tagField('042', [{code: 'a', value: 'germ'}])]);

      assert.equal(computeRuleKey('NAT_BIB', incoming, candidate), 0);
    });

    it('returns 0 when candidate has no 042 fields', () => {
      const incoming = makeRecord([]);
      const candidate = makeRecord([]);

      assert.equal(computeRuleKey('NAT_BIB', incoming, candidate), 0);
    });

    it('finds finb among multiple 042 fields', () => {
      const incoming = makeRecord([]);
      const candidate = makeRecord([
        tagField('042', [{code: 'a', value: 'germ'}]),
        tagField('042', [{code: 'a', value: 'finb'}])
      ]);

      assert.equal(computeRuleKey('NAT_BIB', incoming, candidate), 1);
    });
  });

  describe('LOW_COUNT', () => {
    it('returns the number of LOW fields', () => {
      const incoming = makeRecord([]);
      const candidate = makeRecord([lowField('111'), lowField('222')]);

      assert.equal(computeRuleKey('LOW_COUNT', incoming, candidate), 2);
    });

    it('returns 0 when candidate has no LOW fields', () => {
      const incoming = makeRecord([]);
      const candidate = makeRecord([]);

      assert.equal(computeRuleKey('LOW_COUNT', incoming, candidate), 0);
    });

    it('counts LOW fields without $a subfields too', () => {
      const noA = {tag: 'LOW', ind1: ' ', ind2: ' ', subfields: [{code: 'b', value: 'x'}]};
      const incoming = makeRecord([]);
      const candidate = makeRecord([lowField('111'), noA]);

      assert.equal(computeRuleKey('LOW_COUNT', incoming, candidate), 2);
    });
  });

  describe('ENCODING_LEVEL', () => {
    it('returns 1 for encoding level 1', () => {
      const candidate = makeRecord([], leaderWithEncodingLevel('1'));

      assert.equal(computeRuleKey('ENCODING_LEVEL', makeRecord([]), candidate), 1);
    });

    it('returns a higher index for a less preferred encoding level', () => {
      const candidate = makeRecord([], leaderWithEncodingLevel('8'));

      // '8' is the last (worst) entry of the preference array
      assert.equal(computeRuleKey('ENCODING_LEVEL', makeRecord([]), candidate), 9);
    });

    it('orders levels by preference, not by numeric value', () => {
      const level2 = makeRecord([], leaderWithEncodingLevel('2'));
      const level1 = makeRecord([], leaderWithEncodingLevel('1'));

      assert.ok(computeRuleKey('ENCODING_LEVEL', makeRecord([]), level1)
        < computeRuleKey('ENCODING_LEVEL', makeRecord([]), level2));
    });

    it('returns null when the leader is 17 chars', () => {
      const candidate = makeRecord([], '00000nam a2200000');

      assert.equal(computeRuleKey('ENCODING_LEVEL', makeRecord([]), candidate), null);
    });

    it('returns null for an unknown encoding level char', () => {
      const candidate = makeRecord([], leaderWithEncodingLevel('9'));

      assert.equal(computeRuleKey('ENCODING_LEVEL', makeRecord([]), candidate), null);
    });

    it('accepts a leader that is exactly 18 chars', () => {
      assert.equal(leaderWithEncodingLevel(' ').length, 18);
      const candidate = makeRecord([], leaderWithEncodingLevel(' '));

      assert.equal(computeRuleKey('ENCODING_LEVEL', makeRecord([]), candidate), 0);
    });
  });

  describe('PREPUB_LEVEL', () => {
    it('returns 1 for a machine produced 500', () => {
      const candidate = makeRecord([tagField('500', [{code: 'a', value: 'Koneellisesti tuotettu tietue'}])]);

      assert.equal(computeRuleKey('PREPUB_LEVEL', makeRecord([]), candidate), 1);
    });

    it('returns 2 for a verified prepublication 500', () => {
      const candidate = makeRecord([tagField('500', [{code: 'a', value: 'Tarkistettu ennakkotieto'}])]);

      assert.equal(computeRuleKey('PREPUB_LEVEL', makeRecord([]), candidate), 2);
    });

    it('returns 3 for a plain prepublication 500', () => {
      const candidate = makeRecord([tagField('500', [{code: 'a', value: 'Ennakkotieto.'}])]);

      assert.equal(computeRuleKey('PREPUB_LEVEL', makeRecord([]), candidate), 3);
    });

    it('returns 3 for a 500 with EI VIELÄ ILMESTYNYT', () => {
      const candidate = makeRecord([tagField('500', [{code: 'a', value: 'EI VIELÄ ILMESTYNYT'}])]);

      assert.equal(computeRuleKey('PREPUB_LEVEL', makeRecord([]), candidate), 3);
    });

    it('returns null when there are no matching 5XX fields', () => {
      const candidate = makeRecord([tagField('500', [{code: 'a', value: 'Some other note'}])]);

      assert.equal(computeRuleKey('PREPUB_LEVEL', makeRecord([]), candidate), null);
    });

    it('returns null for a 594 without a FENNI/FIKKA/VIOLA $5', () => {
      const candidate = makeRecord([
        tagField('594', [{code: '5', value: 'KUKKA'}, {code: 'a', value: 'Ennakkotieto'}])
      ]);

      assert.equal(computeRuleKey('PREPUB_LEVEL', makeRecord([]), candidate), null);
    });

    it('counts a 594 with $5 = FENNI', () => {
      const candidate = makeRecord([
        tagField('594', [{code: '5', value: 'FENNI'}, {code: 'a', value: 'Ennakkotieto'}])
      ]);

      assert.equal(computeRuleKey('PREPUB_LEVEL', makeRecord([]), candidate), 3);
    });

    it('returns the best (smallest) level among multiple fields', () => {
      const candidate = makeRecord([
        tagField('500', [{code: 'a', value: 'Ennakkotieto'}]),
        tagField('500', [{code: 'a', value: 'Koneellisesti tuotettu tietue'}])
      ]);

      assert.equal(computeRuleKey('PREPUB_LEVEL', makeRecord([]), candidate), 1);
    });
  });

  describe('unknown rule', () => {
    it('throws for an unknown rule name', () => {
      assert.throws(() => computeRuleKey('NOPE', makeRecord([]), makeRecord([])),
        /Unknown match selector rule: NOPE/u);
    });
  });
});
