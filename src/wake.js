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
  const base = [w, 'desk mate', 'deskmat', 'desk mat', 'deskmay', 'desk may', 'desk me', 'thanks mate', 'thanx mate', 'thanks, mate', 'thanksmate', 'decimate', 'decimated', 'diskmate', 'descimate', 'descomate', 'dismate', 'deck mate', 'desk meat'];
  const sorted = base.sort((a, b) => b.length - a.length);
  return { list: sorted, fuzzy: w };
}

// Levenshtein distance ≤2: catches descmate, deskmat, decimate, etc.
// Real-voice test produced "Decimate" (s→c, k→i = 2 edits) — dist-1 missed it.
function dist1(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; }
    else {
      if (++edits > max) return false;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else { i++; j++; }
    }
  }
  return edits + (a.length - i) + (b.length - j) <= max;
}

const SLEEP_PHRASES = ['sleep', 'go to sleep', 'time to sleep', 'sleep deskmate', 'deskmate sleep', 'go to sleep deskmate', 'sleep now', 'deskmate go to sleep'];

// Resolve the capture index by NAME — SDL's "default" picks whatever is the
// system default, which turns into Bluetooth earbuds (their mic mangles
// speech: "deskmate" came out as "Hey, Dutchman"). Indices also shift when
// devices connect/disconnect, so never hardcode one. Spawn whisper-stream
// briefly, read its device list, kill it.
function resolveCaptureIndex(bin, model, name) {
  return new Promise((resolve) => {
    if (!name) return resolve(null);
    const p = spawn(bin, ['-m', model, '-l', 'en'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { p.kill('SIGKILL'); } catch {}
      resolve(v);
    };
    p.stderr.on('data', (d) => {
      err += d.toString();
      const re = /Capture device #(\d+): '([^']+)'/g;
      const found = [...err.matchAll(re)];
      if (!found.length) return;
      // list is complete once "obtained spec" (or processing) appears, or
      // once we've had the list for a moment and no more lines arrive
      const match = found.find((m) => m[2].toLowerCase().includes(String(name).toLowerCase()));
      if (match) finish(Number(match[1]));
    });
    p.on('error', () => finish(null));
    setTimeout(() => {
      const found = [...err.matchAll(/Capture device #(\d+): '([^']+)'/g)];
      const match = found.find((m) => m[2].toLowerCase().includes(String(name || '').toLowerCase()));
      finish(match ? Number(match[1]) : null);
    }, 4000);
  });
}

function startWake(onCommand, cfg, onSleep) {
  const bin = cfg.wakeBin || 'whisper-stream';
  const model = cfg.wakeModel || '/opt/homebrew/share/whisper.cpp/models/ggml-small.en.bin';
  const matcher = buildMatcher(cfg.wakeWord);
  const base = ['-m', model, '-l', 'en', '--step', '3000', '--length', '4000', '--keep', '1500', '-vth', '0.3', '--keep-context'];
  let proc = null;
  let buf = '';
  let stopped = false;
  let captureIdx = null;

  const spawnOnce = () => {
    if (stopped) return;
    const args = captureIdx == null ? base : [...base, '-c', String(captureIdx)];
    proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, i).replace(/\x1b\[2K/g, '').replace(/\r/g, '').trim();
        buf = buf.slice(i + 1);
        if (!raw || raw.includes('[BLANK_AUDIO]')) continue;
        console.error(`[wake] heard: ${JSON.stringify(raw)}`);
        handleLine(raw);
      }
    });
    proc.on('error', (e) => console.error('wake:', e.message));
    proc.on('close', () => {
      proc = null;
      if (!stopped) setTimeout(spawnOnce, 2000); // restart after a breather
    });
  };

  const handleLine = (line) => {
    // Echo guard: while TTS is speaking, the mic picks up the reply and
    // whisper would transcribe it as a new command — infinite loop. Drop
    // anything heard during speech (we saw "Yeah. Yeah." echoes in logs).
    // Also drop for 5s AFTER TTS ends — the echo lingers in the room and
    // whisper may transcribe the tail end of the answer late (seen live:
    // an "Opening." echo became a command ~2s after TTS finished).
    if (exec.isSpeaking() || Date.now() - exec.lastSpeakEnd() < 5000) return;
    const trimmed = line.trim().replace(/^\[Start speaking\]\s*/, '');
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) return; // noise cue: (water splashing), (sighs) — never a command
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) return; // tag: [Silence], [BLANK_AUDIO] — never speech
    const events = {
      sleep: () => { if (onSleep) onSleep(); },
      command: (cmd) => onCommand(cmd),
    };
    classify(null, line, matcher, events);
  };

  const boot = async () => {
    const want = cfg.wakeCaptureName || 'MacBook Air Microphone';
    try {
      captureIdx = await resolveCaptureIndex(bin, model, want);
      console.error(`[wake] capture: '${want}' → device #${captureIdx == null ? 'default' : captureIdx}`);
    } catch (e) {
      console.error('wake capture probe:', e.message);
      captureIdx = null;
    }
    if (!stopped) spawnOnce(); // first real spawn with the right mic
  };
  boot();

  // Resolve the mic index by name — SDL's default picks Bluetooth earbuds
  // when connected (their mic mangles "deskmate" → "Hey, Dutchman").
  return {
    stop: () => {
      stopped = true;
      if (proc) { try { proc.kill(); } catch {} proc = null; }
    },
  };
}

module.exports = { startWake, buildMatcher, SLEEP_PHRASES, classify, resolveCaptureIndex };

// Pure classifier — always-on: every spoken line is a command. A leading
// wake word ("deskmate ...") is stripped if present (so old habit still
// works); otherwise the whole line is the command. Sleep phrases ack + the
// listener keeps running (awake always true — no stuck-asleep trap).
//   line: whispered text
//   matcher: buildMatcher() result
//   events: { sleep, command } called synchronously
function classify(state, line, matcher, events) {
  const lower = line.toLowerCase();
  const sleepPhrase = SLEEP_PHRASES.find((p) => lower.includes(p));

  if (sleepPhrase) {
    if (events.sleep) events.sleep(); // ack "Bye" — but keep listening
    return { awake: true };
  }

  // Strip a leading wake word if present ("deskmate, write an email").
  const wake = (() => {
    for (const v of matcher.list) {
      const idx = lower.indexOf(v);
      if (idx >= 0) return { word: v, idx };
    }
    const words = lower.split(/[^a-z']+/).filter(Boolean);
    for (const word of words) {
      if (word[0] === matcher.fuzzy[0] && dist1(word, matcher.fuzzy)) return { word, idx: lower.indexOf(word) };
    }
    return null;
  })();

  let cmd = line.trim().replace(/^[,\s]+/, '').trim();
  if (wake && wake.idx <= 2) {
    cmd = line.slice(wake.idx + wake.word.length).trim().replace(/^[,\s]+/, '').trim();
  }
  // reject punctuation/whitespace-only lines — not a real command
  if (cmd && /[a-z0-9]/i.test(cmd)) events.command(cmd);
  return { awake: true };
}

// self-check: exact + fuzzy matcher catches variants
if (require.main === module) {
  const m = buildMatcher('deskmate');
  const cases = ['deskmate tell me today\'s date', 'Descmate, what is the time?', 'desk mate, open safari', 'thanks mate open safari', 'deskmate sleep', 'go to sleep', 'deskmate can you play a song', 'can you play a song', 'Decimate, what is the time?', 'cement play shape of you'];
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