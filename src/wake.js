'use strict';
const { spawn } = require('node:child_process');

// Wake-word listener: runs whisper-stream (continuous mic transcription)
// and fuzzy-matches the user's wake word against the stream. On match, the
// text AFTER the wake word is the command. whisper tiny/base mishear unusual
// words ("yudeat" -> "judy", "you'd eat", "yudhi"), so we match on a list of
// likely acoustic spellings rather than an exact string. The matcher is
// deliberately loose — false positives just show the panel; false negatives
// would kill the feature.

function buildMatcher(wakeWord) {
  const w = (wakeWord || 'yudeat').toLowerCase();
  // acoustic variants of the wake word (tiny/base model mishearings)
  const variants = [w, 'judy', 'judi', 'yudhi', 'yudi', "you'd eat", 'yoo dee at', 'yudeat', 'yud eat', 'yudit'];
  const sorted = variants.sort((a, b) => b.length - a.length);
  return sorted; // longest-first so "you'd eat" beats "you"
}

function startWake(onCommand, cfg) {
  const bin = cfg.wakeBin || 'whisper-stream';
  const model = cfg.wakeModel || '/opt/homebrew/share/whisper.cpp/models/ggml-base.en.bin';
  const matcher = buildMatcher(cfg.wakeWord);
  const args = ['-m', model, '-l', 'en', '-c', String(cfg.wakeCapture || 1), '--step', '3000', '--length', '4000', '-vth', '0.6'];
  let proc = null;
  let buf = '';
  let active = false; // true after wake: accumulate command until silence

  const spawnOnce = () => {
    proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      // whisper-stream output: blocks like "\x1b[2K\r [BLANK_AUDIO]\n" or
      // "\x1b[2K\r You'd eat tell me today's date.\n". Split on newlines,
      // strip the ANSI erase-line code (\x1b[2K) + \r, match the last text
      // block. BLANK_AUDIO = silence.
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, i).replace(/\x1b\[2K/g, '').replace(/\r/g, '').trim();
        buf = buf.slice(i + 1);
        if (!raw || raw.includes('[BLANK_AUDIO]')) continue;
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
    const lower = line.toLowerCase();
    // wake word found: extract the command that follows it
    for (const v of matcher) {
      const idx = lower.indexOf(v);
      if (idx >= 0) {
        const cmd = line.slice(idx + v.length).trim().replace(/^[,.\s]+/, '').trim();
        if (cmd) {
          onCommand(cmd);
        } else {
          active = true; // wake heard, command pending
        }
        return;
      }
    }
    // if we're in command-accumulate mode, append (multi-line commands)
    if (active && line) {
      active = false;
      onCommand(line);
    }
  };

  spawnOnce();
  return () => { if (proc) { try { proc.kill(); } catch {} proc = null; } };
}

module.exports = { startWake, buildMatcher };

// self-check: the fuzzy matcher catches the misheard variants
if (require.main === module) {
  const m = buildMatcher('yudeat');
  const cases = ['judy tell me today\'s date', "you'd eat, tell me today's day", 'yudhi open safari'];
  for (const c of cases) {
    const lower = c.toLowerCase();
    const hit = m.find((v) => lower.includes(v));
    const cmd = hit ? c.slice(lower.indexOf(hit) + hit.length).trim() : '';
    console.log(JSON.stringify({ in: c, hit, cmd }));
  }
}