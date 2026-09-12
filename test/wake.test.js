'use strict';
// Unit test for wake.js state machine (classify) — no mic, no whisper.
const { test } = require('node:test');
const assert = require('node:assert');
const { buildMatcher, classify } = require('../src/wake');

const matcher = buildMatcher('deskmate');

function run(lines, initialAwake = false) {
  let state = { awake: initialAwake };
  const events = [];
  for (const line of lines) {
    state = classify(state, line, matcher, {
      awake: () => events.push('ACK'),
      sleep: () => events.push('SLEEP'),
      command: (cmd) => events.push(`CMD:${cmd}`),
    });
  }
  return { state, events };
}

test('asleep: wake word + command fires command only (ack skipped when command present)', () => {
  const { state, events } = run(['deskmate what is the time']);
  assert.equal(state.awake, true);
  assert.deepEqual(events, ['CMD:what is the time']);
});

test('asleep: bare speech is ignored (no wake word)', () => {
  const { state, events } = run(['hello there']);
  assert.equal(state.awake, false);
  assert.deepEqual(events, []);
});

test('awake: command without wake word works', () => {
  const { state, events } = run(['can you play a song'], true);
  assert.equal(state.awake, true);
  assert.deepEqual(events, ['CMD:can you play a song']);
});

test('awake: sleep word returns to asleep', () => {
  const { state, events } = run(['deskmate sleep'], true);
  assert.equal(state.awake, false);
  assert.deepEqual(events, ['SLEEP']);
});

test('asleep: sleep word alone does nothing', () => {
  const { state, events } = run(['go to sleep']);
  assert.equal(state.awake, false);
  assert.deepEqual(events, []);
});

test('asleep: wake word then next line command', () => {
  const { state, events } = run(['deskmate', 'tell me a joke']);
  assert.equal(state.awake, true);
  assert.deepEqual(events, ['ACK', 'CMD:tell me a joke']);
});

test('fuzzy: Descmate (typo) still wakes', () => {
  const { state, events } = run(['Descmate, what is the time?']);
  assert.equal(state.awake, true);
  assert.deepEqual(events, ['CMD:what is the time?']);
});

test('wake word stripped from mid-sentence usage', () => {
  const { state, events } = run(['deskmate can you open safari']);
  assert.deepEqual(events, ['CMD:can you open safari']);
});

test('bare wake word still acks (no command)', () => {
  const { state, events } = run(['deskmate']);
  assert.equal(state.awake, true);
  assert.deepEqual(events, ['ACK']);
});