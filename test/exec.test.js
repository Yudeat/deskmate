'use strict';

// These tests never invoke osascript - they exercise the whitelist and
// validation logic that runs BEFORE any spawn.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCombo, clickAt, typeText } = require('../src/exec');

test('parseCombo builds script from whitelisted atoms', () => {
  assert.equal(
    parseCombo('cmd+shift+P'),
    'tell application "System Events" to key code 35 using {command down, shift down}'
  );
  assert.equal(parseCombo('cmd+space'), 'tell application "System Events" to key code 49 using {command down}');
  assert.equal(parseCombo('return'), 'tell application "System Events" to key code 36');
});

test('parseCombo rejects injection tokens', () => {
  assert.throws(() => parseCombo('cmd+rm -rf /'));
  assert.throws(() => parseCombo('cmd+evil; do bad'));
  assert.throws(() => parseCombo('cmd+"quit"'));
  assert.throws(() => parseCombo('a+b+c'));
});

test('parseCombo rejects malformed input', () => {
  assert.throws(() => parseCombo(''));
  assert.throws(() => parseCombo('+++'));
  assert.throws(() => parseCombo(null));
});

test('clickAt rejects non-finite or negative coordinates before spawn', () => {
  assert.throws(() => clickAt('abc', 10));
  assert.throws(() => clickAt(-5, 10));
  assert.throws(() => clickAt(NaN, 10));
  assert.throws(() => clickAt(10, Infinity));
});

test('typeText caps length and validates before spawn', () => {
  assert.throws(() => typeText('a'.repeat(501)));
  assert.equal(typeText(''), '');
});