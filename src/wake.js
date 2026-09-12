'use strict';
const { spawn } = require('node:child_process');
const exec = require('./exec');

// Wake-word listener: runs whisper-stream (continuous mic transcription)
// and routes speech through a small state machine.
//
// States:
//   asleep (default) — only the wake word ("deskmate") activates. Bare
//                      speech is ignored.
//   awake            — every spoken line is a command; the wake word is
//                      stripped if present. "sleep" / "go to sleep" /
//                      "deskmate sleep" → back to asleep with a "Bye" ack.
//
// One whisper daemon serves both states — the same stream feeds the
// state machine, so there's no second process and no gap when switching.
//
// The matcher is deliberately loose (edit-distance ≤1 + common acoustic
// spellings) — false positives just show the panel; false negatives kill
// the feature. The classifier is pure (see classify below) so it's
// unit-testable without a mic.

function buildMatcher(wakeWord) {
  const w = (wakeWord || 'deskmate').toLowerCase();
  // Acoustic/typo variants. The model has produced "Deskmate" AND
  // "Descmate" (missing k), so exact variants + fuzzy edit-distance-1.
  const exact = [w, 'desk mate', 'deskmat', 'desk mat', 'thanks mate', 'thanx mate', 'thanks, mate', 'thanksmate'];
  const sorted = exact.sort((a, b) => b.length - a.length);
  return { list: sorted, fuzzy: w };
}

// Levenshtein distance ≤1: catches descmate, deskmat, etc. cheaply.
function dist1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; }
    else {
      if (++edits > 1) return false;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else { i++; j++; }
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

const SLEEP_PHRASES = ['sleep', 'go to sleep', 'time to sleep', 'sleep deskmate', 'deskmate sleep', 'go to sleep deskmate', 'sleep now', 'deskmate go to sleep'];

function startWake(onCommand, cfg, onWake, onSleep) {
  const bin = cfg.wakeBin || 'whisper-stream';
  const model = cfg.wakeModel || '/opt/homebrew/share/whisper.cpp/models/ggml-base.en.bin';
  const matcher = buildMatcher(cfg.wakeWord);
  const args = ['-m', model, '-l', 'en', '-c', String(cfg.wakeCapture || 1), '--step', '3000', '--length', '4000', '--keep', '1500', '-vth', '0.3'];
  let proc = null;
  let buf = '';
  let awake = false; // state machine: asleep until wake word or hotkey

  const spawnOnce = () => {
    proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, i).replace(/\x1b\[2K/g, '').replace(/\r/g, '').trim();
        buf = buf.slice(i + 1);
        if (!raw || raw.includes('[BLANK_AUDIO]')) continue;
        console.error(`[wake] ${awake ? 'awake' : 'asleep'} heard: ${JSON.stringify(raw)}`);
        handleLine(raw);
      }
    });
    proc.on('error', (e) => console.error('wake:', e.message));
    proc.on('close', () => {
      proc = null;
      setTimeout(spawnOnce, 2000); // restart after a breather
    });
  };

  const handleLine = (line) => {
    // Echo guard: while TTS is speaking, the mic picks up the reply and
    // whisper would transcribe it as a new command — infinite loop. Drop
    // anything heard during speech (we saw "Yeah. Yeah." echoes in logs).
    if (exec.isSpeaking()) return;
    const events = {
      awake: () => { if (onWake) onWake(); },
      sleep: () => { if (onSleep) onSleep(); },
      command: (cmd) => onCommand(cmd),
    };
    const next = classify({ awake }, line, matcher, events);
    awake = next.awake;
  };

  spawnOnce();
  return {
    stop: () => { if (proc) { try { proc.kill(); } catch {} proc = null; } },
    setState: (v) => { awake = v; }, // hotkey can wake us without saying the word
  };
}

module.exports = { startWake, buildMatcher, SLEEP_PHRASES, classify };

// Pure state machine — testable without a mic/whisper. Takes the current
// state and a transcribed line; returns the next state + fires callbacks.
//   state: { awake: bool }
//   line: whispered text
//   matcher: buildMatcher() result
//   events: { awake, sleep, command } called synchronously
function classify({ awake }, line, matcher, events) {
  const lower = line.toLowerCase();
  const sleepPhrase = SLEEP_PHRASES.find((p) => lower.includes(p));
  const wake = (() => {
    for (const v of matcher.list) {
      const idx = lower.indexOf(v);
      if (idx >= 0) return { word: v, idx };
    }
    const words = lower.split(/[^a-z']+/).filter(Boolean);
    for (const word of words) {
      if (dist1(word, matcher.fuzzy)) return { word, idx: lower.indexOf(word) };
    }
    return null;
  })();

  if (sleepPhrase) {
    if (awake || wake) {
      if (events.sleep) events.sleep();
      return { awake: false };
    }
    return { awake };
  }

  if (wake) {
    const cmd = line.slice(wake.idx + wake.word.length).trim().replace(/^[,\s]+/, '').trim();
    // Ack only when there's no command in this line — if a command follows,
    // speaking now would echo into the mic and the echo guard would drop the
    // real command (we saw this: "Yo" ack raced the command transcription).
    if (!cmd && events.awake) events.awake();
    if (cmd && events.command) events.command(cmd);
    return { awake: true };
  }

  if (awake && line.trim()) {
    const cmd = line.trim().replace(/^[,\s]+/, '').trim();
    if (cmd && events.command) events.command(cmd);
  }
  return { awake };
}

// self-check: exact + fuzzy matcher catches variants
if (require.main === module) {
  const m = buildMatcher('deskmate');
  const cases = ['deskmate tell me today\'s date', 'Descmate, what is the time?', 'desk mate, open safari', 'thanks mate open safari', 'deskmate sleep', 'go to sleep', 'deskmate can you play a song', 'can you play a song'];
  for (const c of cases) {
    const lower = c.toLowerCase();
    let hit = null;
    for (const v of m.list) {
      const idx = lower.indexOf(v);
      if (idx >= 0) { hit = v; break; }
    }
    if (!hit) {
      const word = lower.split(/[^a-z']+/).find((w) => w && dist1(w, m.fuzzy));
      if (word) hit = word;
    }
    const cmd = hit ? c.slice(lower.indexOf(hit) + hit.length).trim() : '';
    console.log(JSON.stringify({ in: c, hit, cmd }));
  }
}