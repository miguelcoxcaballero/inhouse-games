'use strict';

const KEY_CODES = new Set([
  ...Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`),
  ...Array.from({ length: 10 }, (_, index) => `Digit${index}`),
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
  ...Array.from({ length: 10 }, (_, index) => `Numpad${index}`),
  'Escape', 'Backspace', 'Tab', 'Enter', 'Space', 'Minus', 'Equal', 'BracketLeft', 'BracketRight',
  'Backslash', 'Semicolon', 'Quote', 'Backquote', 'Comma', 'Period', 'Slash', 'CapsLock',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  'ContextMenu', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'NumLock', 'ScrollLock', 'PrintScreen', 'NumpadAdd', 'NumpadSubtract',
  'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter', 'IntlBackslash',
]);

const finiteWithin = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** Return a fresh, bounded event object; never forward arbitrary renderer data. */
function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  switch (input.kind) {
    case 'pointer':
      return finiteWithin(input.x, 0, 1) && finiteWithin(input.y, 0, 1)
        ? { kind: 'pointer', x: input.x, y: input.y } : null;
    case 'relative':
      return finiteWithin(input.dx, -2048, 2048) && finiteWithin(input.dy, -2048, 2048)
        ? { kind: 'relative', dx: Math.round(input.dx), dy: Math.round(input.dy) } : null;
    case 'button':
      return [0, 1, 2].includes(input.button) && typeof input.down === 'boolean'
        ? { kind: 'button', button: input.button, down: input.down } : null;
    case 'wheel':
      return finiteWithin(input.dx, -1200, 1200) && finiteWithin(input.dy, -1200, 1200)
        ? { kind: 'wheel', dx: Math.round(input.dx), dy: Math.round(input.dy) } : null;
    case 'key':
      return KEY_CODES.has(input.code) && typeof input.down === 'boolean'
        ? { kind: 'key', code: input.code, down: input.down } : null;
    case 'release':
      return { kind: 'release' };
    default:
      return null;
  }
}

module.exports = { validateInput, KEY_CODES };
