import assert from 'node:assert';
import {describe, it} from 'node:test';
import fs from 'fs';
import path from 'path';
import {MarcRecord} from '@natlibfi/marc-record';
import {Error as ValidationError} from '@natlibfi/melinda-commons';
import {OPERATIONS} from '@natlibfi/melinda-rest-api-commons';
import validateOwnChanges from './own-authorization.js';

MarcRecord.setValidationOptions({subfieldValues: false});

const FIXTURES_PATH = path.join(import.meta.dirname, '../../../test-fixtures/own-authorization');

const tags1 = fs.readFileSync(path.join(FIXTURES_PATH, 'tags1.json'), 'utf8');
const tags2 = fs.readFileSync(path.join(FIXTURES_PATH, 'tags2.json'), 'utf8');
const tags3 = fs.readFileSync(path.join(FIXTURES_PATH, 'tags3.json'), 'utf8');
const tags4 = fs.readFileSync(path.join(FIXTURES_PATH, 'tags4.json'), 'utf8');
const record1 = fs.readFileSync(path.join(FIXTURES_PATH, 'record1.json'), 'utf8');
const record2a = fs.readFileSync(path.join(FIXTURES_PATH, 'record2a.json'), 'utf8');
const record2b = fs.readFileSync(path.join(FIXTURES_PATH, 'record2b.json'), 'utf8');
const record3 = fs.readFileSync(path.join(FIXTURES_PATH, 'record3.json'), 'utf8');
const record4a = fs.readFileSync(path.join(FIXTURES_PATH, 'record4a.json'), 'utf8');
const record4b = fs.readFileSync(path.join(FIXTURES_PATH, 'record4b.json'), 'utf8');

describe('own-authorization', () => {
  describe('validateChanges', () => {
    it('Should pass', () => {
      const tags = JSON.parse(tags1);
      const record = new MarcRecord(JSON.parse(record1), {subfieldValues: false});

      assert(() => {
        validateOwnChanges({ownTags: tags, incomingRecord: record, operation: OPERATIONS.CREATE});
      });
    });

    it('Should pass (Record comparison)', () => {
      const tags = JSON.parse(tags2);
      const recordA = new MarcRecord(JSON.parse(record2a), {subfieldValues: false});
      const recordB = new MarcRecord(JSON.parse(record2b), {subfieldValues: false});

      assert(() => {
        validateOwnChanges({ownTags: tags, incomingRecord: recordA, existingRecord: recordB});
      });
    });

    it('Should throw', () => {
      const tags = JSON.parse(tags3);
      const record = new MarcRecord(JSON.parse(record3), {subfieldValues: false});

      try {
        validateOwnChanges({ownTags: tags, incomingRecord: record, operation: OPERATIONS.CREATE});
      } catch (error) {
        assert(error instanceof ValidationError);
      }
    });

    it('Should throw (operation UPDATE, no existingRecord)', () => {
      const tags = JSON.parse(tags1);
      const record = new MarcRecord(JSON.parse(record1), {subfieldValues: false});

      try {
        validateOwnChanges({ownTags: tags, incomingRecord: record, operation: OPERATIONS.UPDATE});
      } catch (error) {
        assert(error instanceof ValidationError);
      }
    });


    it('Should throw (Record comparison)', () => {
      const tags = JSON.parse(tags4);
      const recordA = new MarcRecord(JSON.parse(record4a), {subfieldValues: false});
      const recordB = new MarcRecord(JSON.parse(record4b), {subfieldValues: false});

      try {
        validateOwnChanges({ownTags: tags, incomingRecord: recordA, existingRecord: recordB});
      } catch (error) {
        assert(error instanceof ValidationError);
      }
    });

    it('Should skip validation if validate param is false', () => {
      const tags = JSON.parse(tags4);
      const recordA = new MarcRecord(JSON.parse(record4a), {subfieldValues: false});
      const recordB = new MarcRecord(JSON.parse(record4b), {subfieldValues: false});

      const result = validateOwnChanges({ownTags: tags, incomingRecord: recordA, existingRecord: recordB, validate: false});
      assert.equal(result, 'skipped');
    });


  });
});
