import assert from 'node:assert';
import {describe, it} from 'node:test';
import {buildMultiMatchMessage, sendMultiMatchMessage} from './match-selector-multi.js';

describe('buildMultiMatchMessage', () => {
  it('includes candidate count and cataloger name with id', () => {
    const message = buildMultiMatchMessage({
      candidateIds: ['a', 'b', 'c'],
      catalogerId: '123',
      catalogerName: 'Alice'
    });

    const expected =
      'multi-match from melinda-rest-api-validator, 3 candidates found, cataloger: Alice (123)';

    assert.equal(message, expected);
  });

  it('omits the cataloger part when catalogerId is null', () => {
    const message = buildMultiMatchMessage({
      candidateIds: ['a', 'b'],
      catalogerId: null,
      catalogerName: 'Alice'
    });

    assert.equal(message, 'multi-match from melinda-rest-api-validator, 2 candidates found');
  });

  it('omits the cataloger part when catalogerId is undefined', () => {
    const message = buildMultiMatchMessage({candidateIds: ['a', 'b']});

    assert.equal(message, 'multi-match from melinda-rest-api-validator, 2 candidates found');
  });

  it('renders "null" when catalogerName is null but catalogerId is set', () => {
    const message = buildMultiMatchMessage({
      candidateIds: ['a', 'b'],
      catalogerId: '456',
      catalogerName: null
    });

    // catalogerName is string-concatenated, so null is rendered as "null"
    const expected = 'multi-match from melinda-rest-api-validator, 2 candidates found, cataloger: null (456)';

    assert.equal(message, expected);
  });

  it('uses singular count text for a single candidate', () => {
    const message = buildMultiMatchMessage({
      candidateIds: ['a'],
      catalogerId: '789',
      catalogerName: 'Bob'
    });

    const expected =
      'multi-match from melinda-rest-api-validator, 1 candidates found, cataloger: Bob (789)';

    assert.equal(message, expected);
  });
});

describe('sendMultiMatchMessage', () => {
  it('does not throw on a normal call', () => {
    assert.doesNotThrow(() =>
      sendMultiMatchMessage({
        record: {id: 'FI-MELINDA123'},
        candidateIds: ['a', 'b'],
        messageText: 'some message'
      })
    );
  });

  it('does not throw when record is null', () => {
    assert.doesNotThrow(() =>
      sendMultiMatchMessage({
        record: null,
        candidateIds: ['a'],
        messageText: 'some message'
      })
    );
  });

  it('does not throw when record is undefined', () => {
    assert.doesNotThrow(() => sendMultiMatchMessage({candidateIds: ['a'], messageText: 'some message'}));
  });

  it('does not throw when candidateIds is an empty array', () => {
    assert.doesNotThrow(() =>
      sendMultiMatchMessage({
        record: {id: 'FI-MELINDA123'},
        candidateIds: [],
        messageText: 'some message'
      })
    );
  });

  it('does not throw when messageText is empty', () => {
    assert.doesNotThrow(() =>
      sendMultiMatchMessage({
        record: {id: 'FI-MELINDA123'},
        candidateIds: ['a'],
        messageText: ''
      })
    );
  });
});
