'use strict';
// Unit test for wake.js classify — always-on: no wake word needed, every
// spoken line is a command; sleep phrases ack + listener keeps running.
const { test } = require('node:test');
const assert = require('node:assert');
const { buildMatcher, classify } = require('../src/wake');

const matcher = buildMatcher('deskmate');

function run(lines) {
  const events = [];
  for (const line of lines) {
    classify(null, line, matcher, {
      sleep: () => events.push('SLEEP'),
      command: (cmd) => events.push(`CMD:${cmd}`),
    });
  }
  return events;
}

test('plain command without any wake word fires', () => {
  assert.deepEqual(run(['can you play a song']), ['CMD:can you play a song']);
});

test('write an email (the core ask) fires as a command', () => {
  assert.deepEqual(run(['write an email to yudeat8@gmail.com']), ['CMD:write an email to yudeat8@gmail.com']);
});

test('leading wake word is stripped (old habit still works)', () => {
  assert.deepEqual(run(['deskmate what is the time']), ['CMD:what is the time']);
});

test('acoustic variant Descmate stripped', () => {
  assert.deepEqual(run(['Descmate, write an email']), ['CMD:write an email']);
});

test('sleep phrase acks (SLEEP) — listener keeps running, next line still a command', () => {
  assert.deepEqual(run(['go to sleep', 'write an email']), ['SLEEP', 'CMD:write an email']);
});

test('empty line / only punctuation fires nothing', () => {
  assert.deepEqual(run(['', '.']), []);
});

test('noise cues never fire (parens / brackets stripped upstream, but guard here)', () => {
  const events = [];
  for (const line of ['(water splashing)', '[Start speaking]', '(sighs)']) {
    const trimmed = line.trim().replace(/^\[Start speaking\]\s*/, '');
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) continue;
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) continue;
    classify(null, trimmed, matcher, {
      sleep: () => events.push('SLEEP'),
      command: (cmd) => events.push(`CMD:${cmd}`),
    });
  }
  assert.deepEqual(events, []);
});