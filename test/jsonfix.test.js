'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/jsonfix');

test('parses clean JSON', () => {
  const p = parse('{"intent":"HIGHLIGHT","x":125,"y":42,"label":"Frame tool","reply":"Click the Frame tool top left"}');
  assert.equal(p.intent, 'HIGHLIGHT');
  assert.equal(p.x, 125);
  assert.equal(p.y, 42);
  assert.equal(p.label, 'Frame tool');
});

test('strips fenced markdown block', () => {
  const p = parse('```json\n{"intent":"ANSWER","x":-1,"y":-1,"reply":"hello"}\n```');
  assert.equal(p.intent, 'ANSWER');
  assert.equal(p.reply, 'hello');
});

test('recovers from trailing prose', () => {
  const p = parse('{"intent":"KEYS","keys":"cmd+shift+p"} hope that helps!');
  assert.equal(p.keys, 'cmd+shift+p');
});

test('recovers from partial object via regex', () => {
  const p = parse('model said: {"intent": "CLICK", x: 300}');
  assert.equal(p.intent, 'CLICK');
  assert.equal(p.x, 300);
  assert.equal(p.y, -1);
});

test('clamps out-of-range coordinates', () => {
  const p = parse('{"intent":"CLICK","x":5000,"y":-3}');
  assert.equal(p.x, 1000);
  assert.equal(p.y, -1); // any negative = "not applicable"
});

test('caps oversized text and reply', () => {
  const p = parse(`{"intent":"TYPE","text":"${'a'.repeat(900)}","reply":"${'b'.repeat(2000)}"}`);
  assert.equal(p.text.length, 500);
  assert.equal(p.reply.length, 1000);
});

test('rejects unknown intent', () => {
  assert.throws(() => parse('{"intent":"NOPE"}'));
});

test('rejects empty output', () => {
  assert.throws(() => parse('   '));
  assert.throws(() => parse(''));
});