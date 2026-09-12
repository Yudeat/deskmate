'use strict';

const { spawnSync, spawn } = require('node:child_process');

// Key codes for System Events `key code` (macOS virtual key codes).
const KEYCODES = {
  a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4, i: 34, j: 38, k: 40, l: 37,
  m: 46, n: 45, o: 31, p: 35, q: 12, r: 15, s: 1, t: 17, u: 32, v: 9, w: 13, x: 7, y: 16, z: 6,
  '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23, '6': 22, '7': 26, '8': 28, '9': 25,
};
const SPECIAL = {
  space: 49, return: 36, enter: 36, tab: 48, esc: 53, delete: 51, backspace: 51,
  up: 126, down: 125, left: 123, right: 124, home: 115, end: 119, pageup: 116, pagedown: 121,
};
const MODS = {
  cmd: 'command down', command: 'command down',
  option: 'option down', alt: 'option down',
  shift: 'shift down',
  control: 'control down', ctrl: 'control down',
};

function isTccError(r) {
  // TCC denial can surface on stdout OR stderr depending on the spawn
  // context (Electron vs terminal). Check both so it's never misreported
  // as a generic failure with an empty message.
  const err = String(r.stderr || '') + String(r.stdout || '') + String(r.error?.message || '');
  return /not allowed assistive access|-25211|not authorized|not have the required permission|assistive access/i.test(err);
}

// All osascript invocations go through here. Free text is ALWAYS passed as
// argv (spawn array, never a shell string, never concatenated into the
// script body) - the payload can contain quotes, semicolons, newlines, $
// and still stays data, not code. Security boundary.
function osa(script, ...args) {
  const r = spawnSync('osascript', ['-e', script, ...args], { encoding: 'utf8', timeout: 8000 });
  if (isTccError(r)) {
    throw Object.assign(
      new Error('Accessibility permission is missing - grant it in System Settings > Privacy & Security > Accessibility'),
      { code: 'E_PERM_AX' }
    );
  }
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim().slice(0, 300);
    const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
    if (timedOut) {
      throw Object.assign(new Error('osascript timed out - the action did not complete'), { code: 'E_EXEC' });
    }
    throw Object.assign(new Error(`osascript failed: ${detail}`), { code: 'E_EXEC' });
  }
  return (r.stdout || '').trim();
}

// Coordinates are validated integers before interpolation into the script.
function clickAt(x, y) {
  x = Number(x); y = Number(y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 99999 || y > 99999) {
    throw Object.assign(new Error('invalid click coordinates'), { code: 'E_EXEC' });
  }
  x = Math.round(x); y = Math.round(y);
  return osa(`tell application "System Events" to click at {${x}, ${y}}`);
}

// Combos are whitelist-parsed: every token must be a known modifier or a
// single letter/digit/special key. The AppleScript is then built from those
// validated atoms only - untrusted input cannot reach the script text.
function parseCombo(combo) {
  const parts = String(combo || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw Object.assign(new Error('empty keys combo'), { code: 'E_EXEC' });
  const mods = [];
  let key = null;
  for (const p of parts) {
    if (MODS[p]) { mods.push(MODS[p]); continue; }
    if (key !== null) throw Object.assign(new Error('invalid combo - only one key allowed'), { code: 'E_EXEC' });
    if (/^[a-z0-9]$/.test(p) && KEYCODES[p] !== undefined) key = p;
    else if (SPECIAL[p]) key = p;
    else throw Object.assign(new Error(`unsupported key "${p.slice(0, 8)}"`), { code: 'E_EXEC' });
  }
  if (!key) throw Object.assign(new Error('no key in combo'), { code: 'E_EXEC' });
  const kc = KEYCODES[key] ?? SPECIAL[key];
  const using = mods.length ? ` using {${mods.join(', ')}}` : '';
  return `tell application "System Events" to key code ${kc}${using}`;
}

function pressKeys(combo) {
  return osa(parseCombo(combo));
}

// Type via the pasteboard: copy the text, then Cmd+V. Far more reliable
// than per-character `keystroke`, which fails on Chromium fields with
// special chars (-, _, etc.) - exactly the chars in API keys. The text
// still travels as argv data, never concatenated into a script.
function typeText(text) {
  text = String(text ?? '');
  if (!text) return '';
  if (text.length > 500) throw Object.assign(new Error('text too long (>500 chars)'), { code: 'E_EXEC' });
  const chunks = text.split('\n');
  const hasNewlines = chunks.length > 1;
  const body = hasNewlines
    ? 'set the clipboard to (item 1 of argv)\n' +
      'tell application "System Events" to keystroke "v" using command down\n' +
      chunks.slice(1).map(() => 'key code 36').join('\n')
    : 'set the clipboard to (item 1 of argv)\n' +
      'tell application "System Events" to keystroke "v" using command down';
  return osa(`tell application "System Events"\n${body}\nend tell`, text);
}

function frontmostApp() {
  return osa('tell application "System Events" to get name of first application process whose frontmost is true');
}

// Play media via mpv + yt-dlp (native macOS, plays the TOP youtube result).
// mpv's builtin ytdl_hook fails on this build ("Cannot open file ytsearch1:"),
// so resolve the URL via yt-dlp -g ourselves, then hand it to mpv.
// argv-escaped, never shell-concat. spawn, not spawnSync — mpv is long-lived.
let _mpvProc = null;
function playMedia(query) {
  const q = String(query ?? '').trim().slice(0, 200);
  if (!q) return '';
  const resolve = spawnSync('/opt/homebrew/bin/yt-dlp', ['-g', '-f', 'bestaudio', `ytsearch1:${q}`, '--no-playlist'], { encoding: 'utf8', timeout: 60000 });
  if (resolve.status !== 0 || !resolve.stdout.trim()) {
    console.error('yt-dlp:', (resolve.stderr || resolve.stdout || '').trim().slice(0, 200));
    throw Object.assign(new Error('could not resolve media for: ' + q), { code: 'E_EXEC' });
  }
  const url = resolve.stdout.trim().split('\n')[0]; // first format URL
  _mpvProc = spawn('/opt/homebrew/bin/mpv', [url], { stdio: 'ignore', detached: true });
  _mpvProc.on('error', (e) => {
    console.error('mpv:', e.message);
    _mpvProc = null;
  });
  _mpvProc.unref();
  return q;
}
function stopMedia() {
  if (_mpvProc) { try { _mpvProc.kill(); } catch {} _mpvProc = null; }
}
function openUrl(target) {
  const t = String(target ?? '').trim();
  if (!t) return '';
  if (t.length > 512) throw Object.assign(new Error('target too long'), { code: 'E_EXEC' });
  // Basic scheme guard: allow http(s), file, or bare app names.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && !/^[A-Za-z0-9 .-]+$/.test(t)) {
    throw Object.assign(new Error('unsupported open target'), { code: 'E_EXEC' });
  }
  // Reject placeholder/angle-bracket URLs (model echoing prompt examples).
  if (/<|>/.test(t)) {
    throw Object.assign(new Error(`invalid open target: ${t.slice(0, 60)}`), { code: 'E_EXEC' });
  }
  const r = spawnSync('/usr/bin/open', [t], { encoding: 'utf8', timeout: 8000 });
  if (r.status !== 0) {
    throw Object.assign(new Error(`open failed: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`), { code: 'E_EXEC' });
  }
  return (r.stdout || '').trim();
}

// macOS built-in TTS: zero deps. Text goes as argv (never script-concat).
// Fire-and-forget so the UI never blocks; kill the previous utterance so
// rapid replies don't stack/overlap.
let _sayProc = null;
let _speaking = false; // echo guard: true while TTS audio is in the air
let _lastSpeakEnd = 0; // ms epoch when TTS last finished — echo may linger
function isSpeaking() { return _speaking; }
function lastSpeakEnd() { return _lastSpeakEnd; }
function speak(text) {
  const t = String(text ?? '').slice(0, 400).trim();
  if (!t) return;
  try {
    if (_sayProc && !_sayProc.killed) _sayProc.kill();
  } catch { /* already dead */ }
  _speaking = true;
  _sayProc = spawn('/usr/bin/say', [t], { detached: true, stdio: 'ignore' });
  _sayProc.on('error', () => { _speaking = false; _lastSpeakEnd = Date.now(); }); // e.g. TCC/missing binary — never crash
  _sayProc.on('exit', () => { _speaking = false; _lastSpeakEnd = Date.now(); });
  _sayProc.unref();
}

function stopSpeaking() {
  if (_sayProc && !_sayProc.killed) {
    try { _sayProc.kill(); } catch { /* ignore */ }
  }
  _speaking = false;
}

function probeAccessibility() {
  try {
    // If we can read the frontmost app, assistive access is granted.
    frontmostApp();
    return true;
  } catch (e) {
    // Accessibility permission denied surfaces here; treat as a missing permission.
    if (e.code === 'E_PERM_AX') return false;
    // Other failures (e.g. System Events hiccup) are not permission denials.
    return true;
  }
}

module.exports = { clickAt, pressKeys, typeText, frontmostApp, probeAccessibility, parseCombo, speak, stopSpeaking, isSpeaking, lastSpeakEnd, openUrl, playMedia, stopMedia };