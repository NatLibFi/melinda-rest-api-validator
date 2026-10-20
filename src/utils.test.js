import assert from 'node:assert';
import {describe, it} from 'node:test';
import {EventEmitter} from 'node:events';
import {MarcRecord} from '@natlibfi/marc-record';
import {MARCXML} from '@natlibfi/marc-record-serializers';
import {
  updateField001ToParamId,
  getRecordMetadata,
  getSourceIdsFromRecord,
  getSidsFromRecord,
  getSubfieldValues,
  getF035IdsFromRecord,
  getIncomingIdFromRecord,
  getIdFromRecord,
  isValidAlephId,
  toTwoDigits,
  normalizeEmptySubfields,
  normalizeEmptySubfieldsRecord,
  getRecord
} from './utils.js';

MarcRecord.setValidationOptions({subfieldValues: false});

const LEADER = '00000nam a2200000 a 4500';

function makeRecord(fields) {
  return new MarcRecord({leader: LEADER, fields}, {subfieldValues: false});
}

function titleField(a) {
  return {tag: '245', ind1: '1', ind2: ' ', subfields: [{code: 'a', value: a}]};
}

function sidField(c, b) {
  return {tag: 'SID', ind1: ' ', ind2: ' ', subfields: [{code: 'c', value: c}, {code: 'b', value: b}]};
}

describe('utils', () => {
  describe('updateField001ToParamId', () => {
    it('Should set the 001 value when the record has no 001 field', () => {
      const record = makeRecord([titleField('foo.')]);

      const result = updateField001ToParamId('000019640', record);

      const [f001] = result.get(/^001$/u);
      assert.equal(f001.value, '000019640');
    });

    it('Should replace the 001 value when the record already has a 001 field', () => {
      const record = makeRecord([{tag: '001', value: '000000001'}, titleField('foo.')]);

      const result = updateField001ToParamId('000019640', record);

      const [f001] = result.get(/^001$/u);
      assert.equal(f001.value, '000019640');
    });
  });

  describe('getRecordMetadata', () => {
    it('Should use the passed recordMetadata blobSequence', () => {
      const record = makeRecord([titleField('foo.')]);

      const result = getRecordMetadata({
        record,
        recordMetadata: {sourceIds: ['(BIB)123'], title: 'from metadata', standardIdentifiers: ['(035)999'], blobSequence: 7}
      });

      assert.equal(result.blobSequence, 7);
      // KNOWN BUG (see notes in workspace coverage report): the recordMetadata
      // sourceIds/title/standardIdentifiers are silently ignored because the
      // expression `recordMetadata.sourceIds || record ? ... : undefined` is
      // parsed as `(recordMetadata.sourceIds || record) ? ... : undefined`.
      // The values below assert the CURRENT behavior, not the intended one.
      assert.deepStrictEqual(result, {sourceIds: [], blobSequence: 7, title: 'foo', standardIdentifiers: []});
    });

    it('Should derive title and identifiers from the record', () => {
      const record = makeRecord([titleField('foo.'), {tag: '035', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: '123'}]}]);

      const result = getRecordMetadata({record, recordMetadata: {sourceIds: ['(BIB)123']}});

      // getRecordTitle strips the trailing period; standard identifiers only
      // come from 020/022/024 fields, which this record has none of
      assert.equal(result.title, 'foo');
      assert.deepStrictEqual(result.standardIdentifiers, []);
    });

    it('Should derive all values from the record when no recordMetadata is given', () => {
      const record = makeRecord([{tag: '001', value: '000019640'}, titleField('foo.')]);

      const result = getRecordMetadata({record});

      assert.deepStrictEqual(result.sourceIds, ['000019640']);
      assert.equal(result.blobSequence, 1);
      assert.equal(result.title, 'foo');
    });

    it('Should use the number param as blobSequence when given', () => {
      const record = makeRecord([{tag: '001', value: '000019640'}, titleField('foo.')]);

      const result = getRecordMetadata({record, number: 3});

      assert.equal(result.blobSequence, 3);
    });

    it('Should return undefined values when neither record nor recordMetadata is given', () => {
      const result = getRecordMetadata({});

      assert.deepStrictEqual(result, {sourceIds: undefined, blobSequence: 1, title: undefined, standardIdentifiers: undefined});
    });
  });
  describe('getSourceIdsFromRecord', () => {
    it('Should return the incoming id (003+001) when both fields exist', () => {
      const record = makeRecord([{tag: '003', value: 'BIB'}, {tag: '001', value: '000019640'}, sidField('c1', 'B1B')]);

      const result = getSourceIdsFromRecord(record);

      assert.deepStrictEqual(result, ['(BIB)000019640']);
    });

    it('Should return the 035 ids when there is no 001 field', () => {
      const record = makeRecord([
        {tag: '035', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: '111'}, {code: 'z', value: '222'}]},
        {tag: '035', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: '111'}]}
      ]);

      const result = getSourceIdsFromRecord(record);

      assert.deepStrictEqual(result, ['111', '222']);
    });

    it('Should return the SID ids when there is no 001 or 035 field', () => {
      const record = makeRecord([sidField('c1', 'B1B'), sidField('c1', 'B1B')]);

      const result = getSourceIdsFromRecord(record);

      assert.deepStrictEqual(result, ['(B1B)c1']);
    });

    it('Should return an empty array when the record has no source ids', () => {
      const record = makeRecord([titleField('foo.')]);

      assert.deepStrictEqual(getSourceIdsFromRecord(record), []);
    });

    it('Should return all unique source ids when getAllSourceIds is true', () => {
      const record = makeRecord([
        {tag: '003', value: 'BIB'},
        {tag: '001', value: '000019640'},
        {tag: '035', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: '111'}]},
        sidField('c1', 'B1B')
      ]);

      const result = getSourceIdsFromRecord(record, true);

      assert.deepStrictEqual(result, ['(BIB)000019640', '111', '(B1B)c1']);
    });
  });

  describe('getSidsFromRecord', () => {
    it('Should build (db)id source ids from valid SID fields', () => {
      const record = makeRecord([sidField('c1', 'B1B')]);

      assert.deepStrictEqual(getSidsFromRecord(record), ['(B1B)c1']);
    });

    it('Should ignore SID fields that do not have exactly one $c and one $b', () => {
      const invalid = {tag: 'SID', ind1: ' ', ind2: ' ', subfields: [{code: 'c', value: 'c1'}, {code: 'c', value: 'c2'}, {code: 'b', value: 'B1B'}]};
      const record = makeRecord([invalid, sidField('c1', 'B1B')]);

      assert.deepStrictEqual(getSidsFromRecord(record), ['(B1B)c1']);
    });
  });

  describe('getSubfieldValues', () => {
    it('Should return the values of the given subfield code', () => {
      const field = {tag: '600', subfields: [{code: 'a', value: 'one'}, {code: 'b', value: 'two'}, {code: 'a', value: 'three'}]};

      assert.deepStrictEqual(getSubfieldValues(field, 'a'), ['one', 'three']);
      assert.deepStrictEqual(getSubfieldValues(field, 'z'), []);
    });
  });

  describe('getF035IdsFromRecord', () => {
    it('Should collect $a and $z values from all 035 fields and remove duplicates', () => {
      const record = makeRecord([
        {tag: '035', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: '111'}, {code: 'z', value: '222'}, {code: '6', value: 'keep-out'}]},
        {tag: '035', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: '111'}]}
      ]);

      assert.deepStrictEqual(getF035IdsFromRecord(record), ['111', '222']);
    });

    it('Should return an empty array when the record has no 035 fields', () => {
      const record = makeRecord([titleField('foo.')]);

      assert.deepStrictEqual(getF035IdsFromRecord(record), []);
    });
  });

  describe('getIncomingIdFromRecord', () => {
    it('Should return (003)001 when both fields exist', () => {
      const record = makeRecord([{tag: '003', value: 'BIB'}, {tag: '001', value: '000019640'}]);

      assert.equal(getIncomingIdFromRecord(record), '(BIB)000019640');
    });

    it('Should return the 001 value when there is no 003 field', () => {
      const record = makeRecord([{tag: '001', value: '000019640'}]);

      assert.equal(getIncomingIdFromRecord(record), '000019640');
    });

    it('Should return undefined when there is no 001 field', () => {
      const record = makeRecord([titleField('foo.')]);

      assert.equal(getIncomingIdFromRecord(record), undefined);
    });
  });

  describe('getIdFromRecord', () => {
    it('Should return the 001 value as Aleph id when a 001 field exists', () => {
      const record = makeRecord([{tag: '001', value: '123'}]);

      assert.equal(getIdFromRecord(record), '000000123');
    });

    it('Should return undefined when there is no 001 field', () => {
      const record = makeRecord([titleField('foo.')]);

      assert.equal(getIdFromRecord(record), undefined);
    });
  });

  describe('isValidAlephId', () => {
    it('Should return true for 9-digit ids', () => {
      assert.equal(isValidAlephId('123456789'), true);
    });

    it('Should return false for ids that are not 9 digits', () => {
      assert.equal(isValidAlephId('12345678'), false);
      assert.equal(isValidAlephId('12345678a'), false);
      assert.equal(isValidAlephId('1234567890'), false);
    });
  });

  describe('toTwoDigits', () => {
    it('Should pad single digit numbers with a leading zero', () => {
      assert.equal(toTwoDigits(5), '05');
      assert.equal(toTwoDigits(42), '42');
    });
  });

  describe('normalizeEmptySubfields', () => {
    it('Should replace missing or "undefined" subfield values with empty strings', () => {
      const field = {tag: 'CAT', subfields: [{code: 'b'}, {code: 'c', value: 'undefined'}, {code: 'a', value: 'keep'}, {code: 'd', value: ''}]};

      const result = normalizeEmptySubfields(field);

      assert.deepStrictEqual(result.subfields, [
        {code: 'b', value: ''},
        {code: 'c', value: ''},
        {code: 'a', value: 'keep'},
        {code: 'd', value: ''}
      ]);
    });
  });

  describe('normalizeEmptySubfieldsRecord', () => {
    it('Should return a MarcRecord with all empty subfield values normalized', () => {
      const record = makeRecord([
        {tag: 'CAT', ind1: ' ', ind2: ' ', subfields: [{code: 'b'}, {code: 'a', value: 'keep'}]},
        titleField('foo.')
      ]);

      const result = normalizeEmptySubfieldsRecord(record);

      assert(result instanceof MarcRecord);
      const [cat] = result.get(/^CAT$/u);
      assert.deepStrictEqual(cat.subfields, [{code: 'b', value: ''}, {code: 'a', value: 'keep'}]);
      assert.equal(result.leader, LEADER);
    });
  });

  describe('getRecord (SRU client boundary)', () => {
    const recordXml = MARCXML.to(makeRecord([{tag: '001', value: '000019640'}, titleField('foo.')]));

    function makeSruClient(emit) {
      const calls = [];
      return {
        calls,
        searchRetrieve(query) {
          calls.push(query);
          const emitter = new EventEmitter();
          setImmediate(emit, emitter);
          return emitter;
        }
      };
    }

    it('Should query the SRU client with rec.id=<id> and resolve with the record', async () => {
      const client = makeSruClient(emitter => {
        emitter.emit('record', recordXml);
        emitter.emit('end');
      });

      const record = await getRecord(client, '000019640');

      assert.deepStrictEqual(client.calls, ['rec.id=000019640']);
      assert(record instanceof MarcRecord);
      const [f001] = record.get(/^001$/u);
      assert.equal(f001.value, '000019640');
    });

    it('Should resolve with undefined when the SRU response has no record', async () => {
      const client = makeSruClient(emitter => emitter.emit('end'));

      assert.equal(await getRecord(client, '000000001'), undefined);
    });

    it('Should reject when the SRU client emits an error', async () => {
      const err = new Error('sru down');
      const client = makeSruClient(emitter => emitter.emit('error', err));

      await assert.rejects(getRecord(client, '000000001'), err);
    });

    it('Should reject when the SRU response record is not parseable MARCXML', async () => {
      const client = makeSruClient(emitter => {
        emitter.emit('record', 'this is not marcxml');
        emitter.emit('end');
      });

      await assert.rejects(getRecord(client, '000000001'));
    });
  });
});
