import assert from 'node:assert';
import {describe, it} from 'node:test';
import createDebugLogger from 'debug';

import generateTests from '@natlibfi/fixugen';
import {READERS} from '@natlibfi/fixura';
import {MarcRecord} from '@natlibfi/marc-record';
import {validateChanges} from './validate-changes.js';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:validate-changes:test');
const debugData = debug.extend('data');


describe('validateChanges', () => {
  generateTests({
    path: [import.meta.dirname, '..', '..', '..', 'test-fixtures', 'validate-changes'],
    useMetadataFile: true,
    recurse: false,
    fixura: {
      reader: READERS.JSON
    },
    callback: ({getFixture, expectedResult, skipValidation}) => {

      const record1 = new MarcRecord(getFixture('record1.json'), {subfieldValues: false});
      const record2 = new MarcRecord(getFixture('record2.json'), {subfieldValues: false});
      debugData(`Record1:\n${record1}`);
      debugData(`Record2:\n${record2}`);

      if (skipValidation) {
        debug(`Running validation with (4th param) validate: false`);
        const result = validateChanges({incomingRecord: record1, existingRecord: record2, existingId: '000123456', recordMetadata: 'recordMetadata', validate: false});
        debug(`Result: ${result}`);
        assert.equal(result.changeValidationResult, 'skipped');
        return;
      }

      /*
      if (expectedToThrow) {
        debugData(`Expecting error: ${expectedToThrow}, ${expectedStatus}, ${expectedError}`);
        try {
          validateChanges({incomingRecord: record1, existingRecord: record2, validate: true});
          throw new Error('Expected an error');
        } catch (err) {

          debug(`Got error: ${err.status}, ${JSON.stringify(err.payload)}`);

          expect(err).to.be.an('error');
          expect(err.status).to.equal(expectedStatus);
          expect(err.payload.message).to.match(new RegExp(expectedError, 'u'));
          return;
        }
      }
      */

      try {
        const result = validateChanges({incomingRecord: record1, existingRecord: record2, validate: true});
        debug('Did not get an error.');
        assert.deepStrictEqual(result.changeValidationResult, expectedResult);
      } catch (err) {
        debugData(err);
        throw new Error('Did not expect an error');
      }
    }

  });

  describe('leader and Aleph-internal field normalization', () => {
    const LEADER = '00000nam a2200000 a 4500';

    function makeRecord(leader = LEADER, extraFields = []) {
      return new MarcRecord({leader, fields: [{tag: '245', ind1: '1', ind2: ' ', subfields: [{code: 'a', value: 'foo.'}]}, ...extraFields]}, {subfieldValues: false});
    }

    function lowField(a) {
      return {tag: 'LOW', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: a}]};
    }

    function sidField(b) {
      return {tag: 'SID', ind1: ' ', ind2: ' ', subfields: [{code: 'b', value: b}]};
    }

    function catField(c) {
      return {tag: 'CAT', ind1: ' ', ind2: ' ', subfields: [{code: 'c', value: c}]};
    }

    function hidField(a) {
      return {tag: 'HID', ind1: ' ', ind2: ' ', subfields: [{code: 'a', value: a}]};
    }

    it('Should treat records as changed when the existing record has a too short LDR', () => {
      const existing = makeRecord();
      existing.leader = 'short';

      const result = validateChanges({incomingRecord: makeRecord(), existingRecord: existing});

      assert.equal(result.changeValidationResult, true);
    });

    it('Should treat records with identical LOW $a values as unchanged', () => {
      const result = validateChanges({incomingRecord: makeRecord(undefined, [lowField('a'), lowField('a')]), existingRecord: makeRecord(undefined, [lowField('a'), lowField('a')])});

      assert.equal(result.changeValidationResult, false);
    });

    it('Should treat records with identical SID $b values as unchanged', () => {
      const result = validateChanges({incomingRecord: makeRecord(undefined, [sidField('b'), sidField('b')]), existingRecord: makeRecord(undefined, [sidField('b'), sidField('b')])});

      assert.equal(result.changeValidationResult, false);
    });

    it('Should ignore changes in CAT fields when detecting changes', () => {
      const result = validateChanges({incomingRecord: makeRecord(undefined, [catField('a')]), existingRecord: makeRecord(undefined, [catField('b')])});

      assert.equal(result.changeValidationResult, false);
    });

    it('Should treat records with identical HID fields as unchanged', () => {
      const result = validateChanges({incomingRecord: makeRecord(undefined, [hidField('a'), hidField('b')]), existingRecord: makeRecord(undefined, [hidField('a'), hidField('b')])});

      assert.equal(result.changeValidationResult, false);
    });

    it('Should treat records differing only in LDR/05 n vs c as unchanged', () => {
      const result = validateChanges({incomingRecord: makeRecord('00000cam a2200000 a 4500'), existingRecord: makeRecord('00000nam a2200000 a 4500')});

      assert.equal(result.changeValidationResult, false);
    });
  });
});

