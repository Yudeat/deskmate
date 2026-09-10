'use strict';

const path = require('node:path');
const { app, BrowserWindow, globalShortcut, desktopCapturer, ipcMain, screen, shell } = require('electron');

const { loadConfig } = require('./config');
const memory = require('./memory');
const jsonfix = require('./jsonfix');
const { infer } = require('./vision');
const exec = require('./exec');

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
  if (panelWin && !panelWin.isDestroyed()) panelWin.close();
  panelWin = null;
  panelPending = null;
}

function closeOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
  overlayWin = null;
}

function clampToDisplay(work, cx, cy, w, h) {
  const x = Math.max(work.x + 8, Math.min(cx + 16, work.x + work.width - w - 8));
  const y = Math.max(work.y + 8, Math.min(cy + 16, work.y + work.height - h - 8));
  return { x: Math.round(x), y: Math.round(y) };
}

function positionPanel() {
  if (!panelWin) return;
  const pt = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(pt);
  const { width: w, height: h } = panelWin.getBounds();
  const pos = clampToDisplay(display.workArea, pt.x, pt.y, w, h);
  panelWin.setPosition(pos.x, pos.y);
}

function pushPanel() {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('panel:state', panelPending);
}

function showPanel(state) {
  panelPending = state;
  if (!panelWin) {
    panelWin = new BrowserWindow({
      ...WEB,
      width: 430, height: 180,
      frame: false, transparent: true, backgroundColor: '#00000000',
      alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: true, show: false,
    });
    panelWin.on('closed', () => { panelWin = null; panelPending = null; });
    // window close (Escape, cancel, close) must drop any pending action
    panelWin.on('close', () => { pendingAction = null; });
    // no blur-close: clicking another app must not destroy the panel,
    // or the second ask is silently killed.
    panelWin.webContents.once('did-finish-load', pushPanel);
    panelWin.loadFile(path.join(__dirname, 'panel.html'));
  } else {
    pushPanel();
  }
  positionPanel();
  if (!panelWin.isDestroyed()) {
    panelWin.show();
    // Focus in input mode AND when showing a reply/error with a live input
    // box, so the user can type the next question straight away without
    // re-pressing the hotkey. Skip focus only while thinking / action-confirm.
    if (state.mode === 'input' || state.mode === 'info' || state.mode === 'error') panelWin.focus();
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

async function runPipeline(request, opts = {}) {
  const step = opts.step || 0;
  busy = true;
  try {
    cfg = loadConfig();
    const { display, b64, mime } = await captureScreen();
    const mem = cfg.memoryEnabled ? await memory.tail(cfg.memoryPath, cfg.memoryTail) : [];
    const raw = await infer(cfg, request, b64, mime, mem);
    const parsed = jsonfix.parse(raw);

    lastDisplay = display;
    pendingAction = parsed;

    try {
      const appName = await exec.frontmostApp();
      await memory.append(cfg.memoryPath, { app: appName, req: request, reply: parsed.reply, intent: parsed.intent, step });
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
  if (p.x >= 0 && p.y >= 0 && lastDisplay && ['HIGHLIGHT', 'CLICK'].includes(p.intent)) {
    showOverlay(p, lastDisplay);
  }
  if (p.intent === 'CLICK' || p.intent === 'TYPE' || p.intent === 'KEYS') {
    showPanel({ mode: 'action', intent: p.intent, reply: p.reply || `I'll ${p.intent.toLowerCase()} on your screen.`, text: p.text, keys: p.keys });
  } else {
    showPanel({ mode: 'info', reply: p.reply || 'Done.' });
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
    default: return;
  }
}

function closeAll() {
  closePanel();
  closeOverlay();
}

// ---- ipc ----

ipcMain.on('panel:submit', (_e, text) => {
  if (busy) return;
  showPanel({ mode: 'thinking', reply: 'Thinking…' });
  runPipeline(String(text || ''));
});

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
  runPipeline(q, {
    step: stepCount,
    onParsed: (parsed) => {
      if (!parsed.taskComplete && !['CLICK', 'TYPE', 'KEYS'].includes(parsed.intent) && retry < 1) {
        // model talked instead of acting — force a concrete next step once
        continueTask(prev, 1);
      }
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
  if (busy) return;
  showPanel({ mode: 'input', reply: '' });
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