// node:test entry point for the desktop engine. Unit tests live next to this file as
// scripts/<topic>.test.cjs and require the compiled CommonJS output under dist/ (no Electron
// at test time: test only modules that do not import 'electron').
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('compiled engine output is loadable', () => {
  const { reconcileResources } = require(path.join(__dirname, '..', 'dist', 'engine', 'reconcile.js'));
  assert.equal(typeof reconcileResources, 'function');
});
