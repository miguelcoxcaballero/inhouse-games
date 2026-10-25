'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateInput } = require('./input-validation.cjs');

test('input bridge strips unrelated fields and accepts bounded native events', () => {
  assert.deepEqual(validateInput({ kind: 'pointer', x: 0.25, y: 1, command: 'ignored' }), { kind: 'pointer', x: 0.25, y: 1 });
  assert.deepEqual(validateInput({ kind: 'relative', dx: 1.4, dy: -2.8 }), { kind: 'relative', dx: 1, dy: -3 });
  assert.deepEqual(validateInput({ kind: 'key', code: 'ControlRight', down: true }), { kind: 'key', code: 'ControlRight', down: true });
  assert.deepEqual(validateInput({ kind: 'button', button: 2, down: false }), { kind: 'button', button: 2, down: false });
  assert.deepEqual(validateInput({ kind: 'wheel', dx: 0, dy: 120 }), { kind: 'wheel', dx: 0, dy: 120 });
});

test('input bridge rejects arbitrary commands, malformed keys and unbounded coordinates', () => {
  for (const input of [null, [], {}, { kind: 'exec', command: 'anything' }, { kind: 'key', code: 'x; Write-Host anything', down: true }, { kind: 'key', code: 'KeyA', down: 'true' }, { kind: 'pointer', x: NaN, y: 0 }, { kind: 'pointer', x: 1.01, y: 0 }, { kind: 'relative', dx: 2049, dy: 0 }, { kind: 'wheel', dx: 0, dy: -1201 }, { kind: 'button', button: 3, down: true }]) {
    assert.equal(validateInput(input), null);
  }
});
