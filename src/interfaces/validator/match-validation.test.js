import assert from 'node:assert';
import {describe} from 'node:test';
import createDebugLogger from 'debug';

import generateTests from '@natlibfi/fixugen';
import {READERS} from '@natlibfi/fixura';
import {MarcRecord} from '@natlibfi/marc-record';
import {matchValidationForMatchResults} from './match-validation.js';

const debug = createDebugLogger('@natlibfi/melinda-rest-api-validator:validator:match-validation:test');

describe('match-validation', () => {
  describe('matchValidationForMatchResults', () => {
    generateTests({
      path: [import.meta.dirname, '..', '..', '..', 'test-fixtures', 'match-validation'],
      useMetadataFile: true,
      recurse: false,
      fixura: {
        reader: READERS.JSON
      },
      callback: async ({getFixture, expectedBestId, expectedOrder}) => {
        const record = new MarcRecord(getFixture('record.json'), {subfieldValues: false});
        const matchResults = getFixture('candidates.json').map(
          ({id, probability, record: candidateRecord}) => ({
            candidate: {id, record: new MarcRecord(candidateRecord, {subfieldValues: false})},
            probability
          })
        );

        const {matchValidationResult, sortedValidatedMatchResults} =
          await matchValidationForMatchResults(record, matchResults);
        debug(`Best match: ${JSON.stringify(matchValidationResult.result?.candidate?.id)}`);

        assert.deepStrictEqual(
          sortedValidatedMatchResults.map(({candidate: {id: candidateId}}) => candidateId),
          expectedOrder
        );

        if (expectedBestId) {
          assert.strictEqual(matchValidationResult.result.candidate.id, expectedBestId);
          // The best result also carries the incoming record.
          assert.strictEqual(matchValidationResult.record, record);
        } else {
          assert.deepStrictEqual(matchValidationResult, {});
        }
      }
    });
  });
});
