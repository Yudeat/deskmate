'use strict';

const path = require('node:path');
const { app, BrowserWindow, globalShortcut, desktopCapturer, ipcMain, screen, shell } = require('electron');
const { spawn } = require('node:child_process');

const { loadConfig } = require('./config');
const memory = require('./memory');
const jsonfix = require('./jsonfix');
const { infer, transcribe, researchAnswer, commandText } = require('./vision');
const exec = require('./exec');
const { startWake } = require('./wake');
const { search } = require('./research');

let cfg = null;
let panelWin = null;
let panelPending = null;
let overlayWin = null;
let pendingAction = null; // parsed intent awaiting user confirmation
let lastDisplay = null;
let busy = false; // single-flight: ignore hotkey/submit while a pipeline runs
let stepCount = 0; // task-loop step cap
let lastActionKey = null; // stuck-loop guard: same action twice in a row
let lastActionRepeats = 0;
let activeRequest = ''; // the current request — queried by PLAY/OPEN handlers
let voiceActive = false; // push-to-talk / VAD is live

// ---- renderer hardening: every window gets sandbox + context isolation ----
const WEB = {
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
  },
};

// ---- windows ----

function closePanel() {
  if (panelWin && !panelWin.isDestroyed()) {
    const w = panelWin;
    panelWin = null;   // clear ref first: no re-entry into this handler
    w.close();
  }
  panelPending = null;
}

function closeOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
  overlayWin = null;
}

// ---- panel window: full-screen frosted overlay, centered card via CSS ----

function pushPanel() {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('panel:state', panelPending);
}

function showPanel(state) {
  panelPending = state;
  if (!panelWin) {
    // full-screen window on the active display; transparent background,
    // click-through on the dark backdrop (card handles its own clicks)
    const pt = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(pt);
    panelWin = new BrowserWindow({
      ...WEB,
      x: display.bounds.x, y: display.bounds.y,
      width: display.bounds.width, height: display.bounds.height,
      frame: false, transparent: true, backgroundColor: '#00000000',
      alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false,
      show: false,
    });
    panelWin.on('closed', () => { panelWin = null; panelPending = null; });
    panelWin.on('close', () => { pendingAction = null; });
    panelWin.webContents.once('did-finish-load', pushPanel);
    panelWin.loadFile(path.join(__dirname, 'panel.html'));
  } else {
    pushPanel();
  }
  if (!panelWin.isDestroyed()) {
    panelWin.show();
    // Focus the input box so the user can type or press Enter / Esc.
    // Skip focus while thinking / action-confirm.
    if (state.mode === 'input' || state.mode === 'info' || state.mode === 'error' || state.mode === 'listening') panelWin.focus();
  }
}

function showOverlay(p, display) {
  closeOverlay();
  overlayWin = new BrowserWindow({
    ...WEB,
    x: display.bounds.x, y: display.bounds.y,
    width: display.bounds.width, height: display.bounds.height,
    frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false, focusable: false, show: false,
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true); // click-through: agent never blocks input
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'), {
    query: {
      x: String(p.x), y: String(p.y), label: p.label || '', ms: String((cfg && cfg.overlayMs) || 6000),
    },
  });
  overlayWin.once('ready-to-show', () => { if (overlayWin) overlayWin.show(); });
}

// ---- v2.5: full-screen "halo" — the border lights up when the agent activates ----
let haloWin = null;
function showHalo(mode) {
  // single halo covering the display under the cursor (like the overlay)
  closeHalo();
  const pt = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(pt);
  haloWin = new BrowserWindow({
    ...WEB,
    x: display.bounds.x, y: display.bounds.y,
    width: display.bounds.width, height: display.bounds.height,
    frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false, focusable: false, show: false,
  });
  haloWin.setAlwaysOnTop(true, 'screen-saver');
  haloWin.setIgnoreMouseEvents(true); // glow never blocks clicks
  haloWin.loadFile(path.join(__dirname, 'halo.html'), { query: { mode: String(mode || 'active') } });
  haloWin.once('ready-to-show', () => { if (haloWin) haloWin.show(); });
}
function closeHalo() {
  if (haloWin && !haloWin.isDestroyed()) haloWin.close();
  haloWin = null;
}

// ---- capture ----

async function captureScreen() {
  const pt = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(pt);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source) throw Object.assign(new Error('no screen source available'), { code: 'E_SCREEN' });
  // TCC denial shows up here as an empty thumbnail - trap it, don't crash.
  if (!source.thumbnail || source.thumbnail.isEmpty()) {
    throw Object.assign(
      new Error('Screen Recording permission is not granted - System Settings > Privacy & Security > Screen Recording, then restart deskmate'),
      { code: 'E_PERM_SCREEN' }
    );
  }
  // toJPEG(75): ~4K frame -> ~300KB. Downscale was already done for free by thumbnailSize.
  return { display, b64: source.thumbnail.toJPEG(75).toString('base64'), mime: 'image/jpeg' };
}

// ---- pipeline ----

// Decide: does the request need the screen, or is it a command/knowledge
// question? EXPLICIT screen words → capture + vision (user asked to see
// something). Everything else → direct action (text-only LLM): "play a
// song on youtube" → OPEN the search URL, never a screenshot.
// Heuristic, not a model call — zero extra latency.
// (ponytail: keyword lists; a classifier could replace this if misroutes.)
const SCREEN_WORDS = ['screen', 'screenshot', 'desktop', 'window', 'app', 'click', 'open', 'type', 'file', 'folder', 'tab', 'button', 'menu', 'icon', 'showing', 'display', 'on my', 'this page', 'what do you see', 'what is on', 'read', 'summarize', 'summary', 'explain this', 'what does this', 'what is this', 'look at', 'see this'];
const WORLD_WORDS = ['weather', 'today', 'news', 'capital', 'president', 'who won', 'what is the', 'what was the', 'when did', 'how far', 'population', 'meaning', 'recipe', 'who is', 'what time', 'temperature', 'forecast', 'stock', 'price', 'distance', 'history', 'famous', 'country', 'city', 'date today', 'day today'];

function needsScreen(request) {
  const r = (' ' + String(request || '').toLowerCase() + ' ');
  for (const w of SCREEN_WORDS) if (r.includes(w)) return true;
  return false; // default: NO screenshot — direct action
}

async function runPipeline(request, opts = {}) {
  const step = opts.step || 0;
  busy = true;
  activeRequest = String(request || '').trim();
  console.error(`[pipeline] start req=${JSON.stringify(String(request || '').slice(0, 80))}`);
  try {
    cfg = loadConfig();
    const mem = cfg.memoryEnabled ? await memory.tail(cfg.memoryPath, cfg.memoryTail) : [];

    if (!needsScreen(request)) {
      // Direct-action path: NO screenshot. The LLM emits OPEN/TYPE/KEYS
      // (execute immediately — user said "just do it") or ANSWER (speak).
      // For world/knowledge questions, ground with research first.
      const isWorld = WORLD_WORDS.some((w) => (' ' + String(request || '').toLowerCase() + ' ').includes(w));
      if (isWorld) {
        showPanel({ mode: 'thinking', reply: 'Researching…' });
        const results = await search(request);
        const raw = await researchAnswer(cfg, request, results);
        const parsed = jsonfix.parse(raw);
        lastDisplay = null;
        if (!opts.onParsed) pendingAction = parsed;
        try {
          const appName = await exec.frontmostApp();
          await memory.append(cfg.memoryPath, { app: appName, req: request, reply: parsed.reply, intent: parsed.intent, step, mode: 'research' });
        } catch { /* best-effort */ }
        renderResult(parsed);
        if (opts.onParsed) opts.onParsed(parsed);
        return;
      }
      showPanel({ mode: 'thinking', reply: 'Working…' });
      const raw = await commandText(cfg, request, mem);
      const parsed = jsonfix.parse(raw);
      lastDisplay = null;
      if (!opts.onParsed) pendingAction = parsed;
      try {
        const appName = await exec.frontmostApp();
        await memory.append(cfg.memoryPath, { app: appName, req: request, reply: parsed.reply, intent: parsed.intent, step, mode: 'command' });
      } catch { /* memory is best-effort */ }
      renderResult(parsed);
      if (opts.onParsed) opts.onParsed(parsed);
      return;
    }

    // screen path: capture + vision (current behavior)
    const { display, b64, mime } = await captureScreen();
    const raw = await infer(cfg, request, b64, mime, mem);
    const parsed = jsonfix.parse(raw);

    lastDisplay = display;
    // Only a fresh question (no continuation opts) sets the pending action.
    // Continuations render their own next step; clobbering it here would
    // let a mid-task answer overwrite an unconfirmed action.
    if (!opts.onParsed) pendingAction = parsed;

    try {
      const appName = await exec.frontmostApp();
      await memory.append(cfg.memoryPath, { app: appName, req: request, reply: parsed.reply, intent: parsed.intent, step, mode: 'screen' });
    } catch { /* memory is best-effort */ }

    renderResult(parsed);
    if (opts.onParsed) opts.onParsed(parsed);
  } catch (e) {
    renderError(e);
  } finally {
    busy = false;
  }
}

function renderResult(p) {
  exec.stopSpeaking();
  closeHalo(); // the border glow was for activation — dim it once we answer
  if (p.x >= 0 && p.y >= 0 && lastDisplay && ['HIGHLIGHT', 'CLICK'].includes(p.intent)) {
    showOverlay(p, lastDisplay);
  }
  // OPEN is a direct action — the user said "just do it", no confirm.
  if (p.intent === 'OPEN') {
    try {
      exec.openUrl(p.url || p.reply || '');
      showPanel({ mode: 'info', reply: p.reply || 'Opening…' });
      if (cfg && cfg.ttsEnabled) exec.speak(p.reply || 'Opening…');
    } catch (e) {
      renderError(e);
    }
    return;
  }
  // PLAY is direct too — mpv plays the top youtube result for the query.
  if (p.intent === 'PLAY') {
    try {
      // Guard against the model echoing an unrelated query (saw llama3.2
      // repeat a previous example). Derive the query from the REQUEST when
      // the model's text doesn't look derived from it.
      const reqWords = new Set(String(activeRequest || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
      let query = p.text || '';
      const textWords = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const overlap = textWords.filter((w) => reqWords.has(w)).length;
      if (!query || overlap < Math.min(1, textWords.length)) {
        // derive: strip leading 'play'/'please' + trailing 'on youtube'
        query = String(activeRequest || '').replace(/^(please\s+)?play\s+/i, '').replace(/\s+on\s+(youtube|music)\s*$/i, '').trim() || query;
      }
      exec.playMedia(query);
      showPanel({ mode: 'info', reply: p.reply || 'Playing…' });
      if (cfg && cfg.ttsEnabled) exec.speak(p.reply || 'Playing…');
    } catch (e) {
      renderError(e);
    }
    return;
  }
  // STOP is direct too — kill whatever mpv is playing.
  if (p.intent === 'STOP') {
    try {
      exec.stopMedia();
      const msg = p.reply || 'Stopped.';
      showPanel({ mode: 'info', reply: msg });
      if (cfg && cfg.ttsEnabled) exec.speak(msg);
    } catch (e) {
      renderError(e);
    }
    return;
  }
  // MAIL: build a mailto: draft (to, subject, body) and open it in Mail.app.
  // The user reviews + clicks Send — deskmate has no SMTP/Gmail API.
  if (p.intent === 'MAIL') {
    try {
      const to = String(p.url || '').trim().replace(/^mailto:/i, '');
      const body = String(p.text || p.reply || '').trim();
      if (!to || !body) throw Object.assign(new Error('model returned no recipient or body for MAIL'), { code: 'E_EXEC' });
      const subject = String(p.label || 'Job Inquiry').trim();
      const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      exec.openUrl(mailto);
      const msg = p.reply || `Opened a draft for ${to} — review and hit Send.`;
      showPanel({ mode: 'info', reply: msg });
      if (cfg && cfg.ttsEnabled) exec.speak(msg);
    } catch (e) {
      renderError(e);
    }
    return;
  }
  const follow = p.followUp ? `\n\n${p.followUp}` : '';
  if (p.intent === 'CLICK' || p.intent === 'TYPE' || p.intent === 'KEYS') {
    showPanel({ mode: 'action', intent: p.intent, reply: (p.reply || `I'll ${p.intent.toLowerCase()} on your screen.`) + follow, text: p.text, keys: p.keys });
    if (cfg && cfg.ttsEnabled) exec.speak((p.reply || `I'll ${p.intent.toLowerCase()} on your screen.`) + (p.followUp ? ' ' + p.followUp : ''));
  } else {
    showPanel({ mode: 'info', reply: (p.reply || 'Done.') + follow });
    if (cfg && cfg.ttsEnabled) exec.speak((p.reply || 'Done.') + (p.followUp ? ' ' + p.followUp : ''));
  }
}

const ERR_HINTS = {
  E_PERM_SCREEN: 'Screen Recording permission is not granted.\nSystem Settings > Privacy & Security > Screen Recording, then restart deskmate.',
  E_PERM_AX: 'Accessibility permission is not granted.\nSystem Settings > Privacy & Security > Accessibility, then restart deskmate.',
  E_CONFIG: 'Configuration problem.',
  E_VISION: 'Vision provider error.',
  E_PARSE: 'The model returned something I could not understand.',
  E_EXEC: 'The action failed.',
  E_SCREEN: 'Could not capture the screen.',
};

function renderError(e) {
  console.error(`[error] ${e.code || 'E_UNKNOWN'}: ${String(e.message).slice(0, 200)}`);
  closeHalo(); // error = not active; the border goes off
  const hint = ERR_HINTS[e.code] || 'Unexpected error.';
  const detail = e.message && e.message !== hint ? `\n\n${e.message}` : '';
  showPanel({ mode: 'error', code: e.code, reply: hint + detail });
}

// ---- execution (always behind an explicit in-app confirm) ----

async function executeAction(p) {
  // Recompute the display NOW, at action time - not the stale one from
  // ask-time. The user may have moved windows/displays between capture
  // and "Do it"; coordinates must resolve against the CURRENT layout.
  const pt = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(pt);
  const b = display.bounds;
  switch (p.intent) {
    case 'CLICK': return exec.clickAt(b.x + (p.x / 1000) * b.width, b.y + (p.y / 1000) * b.height);
    case 'TYPE': return exec.typeText(p.text);
    case 'KEYS': return exec.pressKeys(p.keys);
    default:
      // Non-action intents (HIGHLIGHT/ANSWER) should never reach execution;
      // if one does (race/corrupt state), fail loudly instead of "succeeding".
      throw Object.assign(new Error(`cannot execute intent "${p.intent}"`), { code: 'E_EXEC' });
  }
}

function closeAll() {
  closePanel();
  closeOverlay();
  closeHalo();
}

// ---- v2: voice recording (ffmpeg, zero deps) + TTS wiring ----

let recProc = null;
function startRecording(file) {
  // silencedetect on stderr: "silence_start: X" fires when the mic goes
  // quiet. Auto-stop after real speech + a pause → no second hotkey press.
  // -t 20 caps runaway recordings. (ponytail: fixed noise threshold; expose
  // in config if your mic is noisy.)
  recProc = spawn('ffmpeg', [
    '-y', '-f', 'avfoundation', '-i', ':0',
    '-ar', '16000', '-ac', '1',
    '-af', 'silencedetect=noise=-30dB:d=0.7',
    '-t', '20', file,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const started = Date.now();
  recProc.stderr.on('data', (buf) => {
    if (String(buf).includes('silence_start')) {
      if ((Date.now() - started) / 1000 >= 1.2) autoStop();
    }
  });
  recProc.on('error', (e) => {
    recProc = null;
    if (voiceActive) {
      voiceActive = false;
      busy = false;
      renderError(Object.assign(new Error('Mic unavailable — grant Microphone permission in System Settings and restart deskmate'), { code: 'E_MIC' }));
    }
  });
  recProc.on('close', () => {
    // -t 20 cap hit: flush whatever we have (or nothing, if TCC-blocked).
    if (voiceActive) autoStop();
  });
}
function stopRecording() {
  if (recProc) { try { recProc.kill('SIGTERM'); } catch {} recProc = null; }
}
const REC = '/tmp/deskmate-voice.wav';

// Stop listening + transcribe + run. Shared by VAD, manual 2nd press, and the mic button.
function autoStop() {
  if (!voiceActive) return;
  voiceActive = false;
  stopRecording();
  flushVoice(); // sets busy itself; flushes + runs the pipeline
}

// Shared voice path: button + hotkey both route here. Transcribe the last
// recording and run it through the same pipeline as a typed question.
async function flushVoice() {
  busy = true; // hold busy through transcribe+run so a hotkey press mid-flight can't re-trigger
  try {
    const wav = require('node:fs').readFileSync(REC);
    if (!wav.length) { busy = false; return; } // nothing said / TCC-blocked: stay quiet, don't error
    showPanel({ mode: 'thinking', reply: 'Working…' });
    const text = await transcribe(cfg, wav);
    if (text) await runPipeline(text, {});
  } catch (e) {
    renderError(e);
  } finally {
    busy = false;
  }
}

// ---- ipc ----

ipcMain.on('panel:submit', (_e, text) => {
  if (busy) return;
  exec.stopSpeaking();
  showPanel({ mode: 'thinking', reply: 'Thinking…' });
  runPipeline(String(text || ''));
});

// push-to-talk: hotkey down = record, up = transcribe + run
ipcMain.on('voice:start', () => { if (!voiceActive && !busy) onHotkey(); });
ipcMain.on('voice:stop', () => autoStop());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Continuation loop: after an action, re-screenshot (after a settle delay
// so the UI has actually updated) and ask the model what's next. If the
// model dodges with prose instead of proposing an action, retry once with
// a hard force-action instruction. Stuck-guard: same action twice = stop.
function continueTask(prev, retry) {
  const key = `${prev.intent}|${prev.x}|${prev.y}|${prev.keys}|${prev.text}`;
  if (key === lastActionKey) lastActionRepeats += 1;
  else { lastActionKey = key; lastActionRepeats = 1; }
  if (lastActionRepeats >= 2) {
    showPanel({ mode: 'info', reply: 'I keep trying the same action — the screen may not have changed. What would you like me to do next?' });
    return;
  }
  const q = retry
    ? 'You must propose exactly ONE next action as CLICK, TYPE, or KEYS with real x,y coordinates (0-1000). No prose-only replies.'
    : `Continue the task: ${prev.reply || ''} — You already acted on the screen. Look at the CURRENT screen: did the action work? If the task is done, set taskComplete=true. Otherwise propose exactly one next action (CLICK/TYPE/KEYS) with x,y.`;
  showPanel({ mode: 'thinking', reply: 'Checking…' });
  // continuation keeps the panel quiet (no full renderResult) and routes
  // the parsed result straight to the panel + loop, not through the
  // full result renderer (which would double-render).
  runPipeline(q, {
    step: stepCount,
    onParsed: (parsed) => {
      if (parsed.taskComplete) {
        stepCount = 0; lastActionKey = null; lastActionRepeats = 0;
        showPanel({ mode: 'info', reply: parsed.reply || 'Done.' });
        return;
      }
      if (['CLICK', 'TYPE', 'KEYS'].includes(parsed.intent)) {
        pendingAction = parsed;
        showPanel({ mode: 'action', intent: parsed.intent, reply: parsed.reply || `I'll ${parsed.intent.toLowerCase()} on your screen.`, text: parsed.text, keys: parsed.keys });
        return;
      }
      if (parsed.intent === 'ANSWER') {
        showPanel({ mode: 'info', reply: parsed.reply || '' });
        return;
      }
      // HIGHLIGHT or prose-dodge: force a concrete next step once
      if (retry < 1) continueTask(prev, 1);
    },
  });
}

ipcMain.on('panel:confirm', async () => {
  const p = pendingAction;
  pendingAction = null;
  if (!p) return;
  closeOverlay();
  try {
    await executeAction(p);

    stepCount += 1;
    if (!p.taskComplete && stepCount < 3) {
      await sleep(900); // let the UI (modal, focus change) settle before re-capture
      continueTask(p, 0);
      return;
    }

    stepCount = 0; lastActionKey = null; lastActionRepeats = 0;
    showPanel({ mode: 'info', reply: 'Done.' }); // stay open for the next question
  } catch (e) {
    renderError(e);
  }
});

ipcMain.on('panel:cancel', () => {
  pendingAction = null;
  closeAll();
});

ipcMain.on('open:settings', (_e, pane) => {
  shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${String(pane || '')}`);
});

// ---- startup ----

async function startupProbe() {
  const problems = [];
  try {
    await captureScreen();
  } catch (e) {
    problems.push({ code: 'screen', label: `Screen Recording${e.code === 'E_PERM_SCREEN' ? '' : ` (${e.message})`}` });
  }
  if (!exec.probeAccessibility()) problems.push({ code: 'ax', label: 'Accessibility' });
  return problems;
}

function onHotkey() {
  if (busy && !voiceActive) return;
  if (voiceActive) {
    // second press while listening = cancel (VAD already auto-sends)
    voiceActive = false;
    stopRecording();
    busy = false;
    closeAll();
    return;
  }
  // Siri-style: one press starts listening. VAD auto-stops + sends when
  // you pause after speaking. No second press needed.
  voiceActive = true;
  startRecording(REC);
  showPanel({ mode: 'listening', reply: 'Listening… speak, then pause.' });
  showHalo('listening'); // border lights up when the agent is listening
  busy = true; // block re-entry while recording
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName('deskmate');
  app.whenReady().then(async () => {
    app.dock?.hide();

    const problems = await startupProbe();
    if (problems.length) {
      showPanel({
        mode: 'error',
        code: 'E_PERM',
        reply: 'deskmate is missing permissions:\n- ' + problems.map((p) => p.label).join('\n- ') +
          '\n\nGrant them, then press the hotkey again.',
      });
    }

    try {
      cfg = loadConfig();
      const ok = globalShortcut.register(cfg.hotkey, onHotkey);
      if (!ok) console.error('hotkey registration failed:', cfg.hotkey);
      // Siri-style wake loop: wake word ("deskmate") → awake → commands
      // until "sleep". Hotkey wakes too. Skip in smoke mode (no mic).
      if (cfg.wakeEnabled && !process.env.DESKMATE_SMOKE) {
        let wakeStop = null;
        try {
          wakeStop = startWake((line) => {
            const req = String(line || '').trim();
            if (!req) return; // heard but nothing said — keep waiting
            if (busy) return; // don't stack commands over an in-flight one
            showPanel({ mode: 'thinking', reply: 'Working…' });
            runPipeline(req);
          }, cfg, () => {
            // wake word heard → border lights up + instant ack so the user
            // knows it's listening
            showHalo('yo');
            exec.speak('Yo');
          }, () => {
            // sleep word heard → ack + the border goes off + loop goes quiet
            exec.speak('Bye');
            closePanel();
            closeHalo();
          });
        } catch (e) {
          console.error('wake:', e.message);
        }
        // Hotkey wakes the agent without saying the wake word.
        if (wakeStop) {
          const origHotkey = onHotkey;
          onHotkey = () => {
            wakeStop.setState(true); // awake until told to sleep
            origHotkey();
          };
        }
        app.on('will-quit', () => { if (wakeStop) wakeStop.stop(); });
      }
    } catch (e) {
      console.error('config:', e.message);
      renderError(e);
    }

    if (process.env.DESKMATE_SMOKE) {
      console.log('SMOKE_OK problems=' + problems.map((p) => p.code).join(',') + ' cfg=' + (cfg ? 'ok' : 'missing'));
      app.quit();
    }
  });
}