# deskmate — system design & architecture (v1)

Scope: personal-use macOS desktop assistant. Single user, bring-your-own-API-key.
No accounts, no server, no auth, no multi-tenant anything. Rename freely.

## 1. Goal

Hotkey-triggered screen assistant: look at my screen, answer / annotate / act.
Latency budget: hotkey -> annotation on screen in ~1.5-3s.

## 2. Non-goals (explicitly cut for v1)

- Continuous or screen-delta watching (event-driven only: trigger = hotkey)
- Multi-user / auth / billing
- Voice input (phase 2), AX accessibility tree (phase 3)
- Workflow engines (n8n/Flowise), history/state, "did it work" verification

## 3. The whole app is one function

No orchestrator core, no event-loop framework, no state engine.

```
hotkey (Cmd+Shift+Space)
  -> capture display under cursor (desktopCapturer, auto-capped to 1080p)
  -> JPEG q75 -> base64            (~150ms)
  -> prompt(user request + image, JSON-only schema)
  -> provider API (gemini/groq/ollama)   (~1-2.5s)
  -> jsonfix() parse                 (<50ms)
  -> if HIGHLIGHT/ANSWER: draw ring+label on overlay
  -> if CLICK/TYPE/KEYS: show panel [Do it] [Cancel], then execute on confirm
```

Everything lives in one async `handleTrigger()` in the main process.

## 4. Components

### 4.1 Main process (Electron, plain Node — no bundler)

- `globalShortcut.register('Cmd+Shift+Space')` -> handleTrigger
- `desktopCapturer.getSources({types:['screen']})`:
  - pick the source whose `display_id` matches `screen.getDisplayNearestPoint(screen.getCursorScreenPoint())`
  - set `thumbnailSize` to height 1080 — Electron scales the capture to fit,
    so the downscale step is free (zero custom resize code)
  - encode JPEG q75, base64
- fetch to the configured provider (4.5)
- on CLICK/TYPE/KEYS, invoke the executor (4.4) after panel confirm

### 4.2 Overlay window

Frameless, transparent, always-on-top, fullscreen over the target display,
`setIgnoreMouseEvents(true)` permanently. SVG stretched to the window; target
is a ring + label rendered from normalized coords. CSS transition on opacity
(~150ms) for fade. No GSAP, no canvas.

Windows are created per trigger and closed ~6s after render (or on confirm) —
transparent windows are cheap; reuse/resize logic costs more than recreation.

### 4.3 Panel window (small second window)

The overlay can't receive clicks (that's its job — passing them through), so
confirmation/reply lives in a small frameless always-on-top window positioned
~40px offset from the highlight, clamped to screen edge:
- intent ANSWER/HIGHLIGHT: shows `reply` text
- intent CLICK/TYPE/KEYS: shows reply + [Do it] / [Cancel]

`ponytail: two windows; if Electron ever gets per-region mouse-event ignore,
the panel collapses into the overlay.`

### 4.4 Executor (zero dependencies)

AppleScript -> System Events:

```
tell application "System Events" to click at {x, y}
tell application "System Events" to keystroke "text"
tell application "System Events" to key code 59 using command down   # cmd+shift+p
```

Requires Accessibility permission (same dialog users grant for screen recording).
`ponytail: ~150ms/call overhead; if that hurts in phase 2, swap in a pyautogui
sidecar — same interface, one file changes.`

### 4.5 Vision provider — one request builder, 3 branches

config.json:

```json
{
  "hotkey": "Cmd+Shift+Space",
  "provider": "gemini",
  "apiKey": "",
  "model": "gemini-2.5-flash",
  "confirm": true
}
```

| provider | model | cost | notes |
|----------|-------|------|-------|
| gemini   | gemini-2.5-flash   | free tier | primary; JSON-friendly, vision built-in |
| groq     | vision model (llama-3.2-11b) | free tier | faster, lower accuracy |
| ollama   | minicpm-v / llama3.2-vision | offline | localhost:11434, no key |

`buildPayload(provider, image, prompt)` with a small switch. No class
hierarchy, no plugin system — three branches.

## 5. The prompt (fixed, JSON-only)

```
You are a screen assistant. You receive one screenshot and one user request.
Respond with ONLY valid JSON, no prose, no markdown fences:
{
  "intent": "HIGHLIGHT" | "CLICK" | "TYPE" | "KEYS" | "ANSWER",
  "x": integer 0-1000, -1 if not applicable,
  "y": integer 0-1000, -1 if not applicable,
  "label": "short on-screen text near the point",
  "text": "text to type (TYPE only)",
  "keys": "combo like cmd+shift+p (KEYS only)",
  "reply": "your answer, spoken-style"
}
Rules:
- x/y are fractions of the screenshot scaled to 0-1000, integers.
- HIGHLIGHT: always guess coordinates rather than -1.
- CLICK: best-guess coordinates.
- ANSWER: answer from the screenshot, x/y = -1.
```

Integer 0-1000 (not 0-1 floats): LLMs output reliable integers; the app
multiplies `x/1000 * bounds.width`. Screenshot and mapping are per-display, so
Retina pixel density cancels out — this is the entire "coordinate drift" fix.

## 6. Coordinate mapping (the only real gotcha)

1. Capture is per-display: source matching the display under the cursor.
2. LLM returns (x, y) in 0-1000 relative to the screenshot.
3. Screen target on that display: `x/1000 * bounds.width`, `y/1000 * bounds.height`
   where `bounds` = Electron `Display.bounds` (DIP).

Because both axes are fractional, capture pixel density (1x/2x) never matters.
Mixed-DPI multi-monitor works because everything stays on one display's frame.

## 7. Project skeleton (~15 files)

```
deskmate/
  package.json            # electron only, no bundler
  src/main.js             # hotkey, capture, dispatch, window lifecycle
  src/prompt.js           # system prompt + buildPayload per provider
  src/jsonfix.js          # strip fences, recover JSON from LLM output
  src/vision.js           # fetch -> provider, timeout, error surfacing
  src/exec.js             # AppleScript click/keystroke/keys
  src/config.js           # load config.json, defaults
  src/overlay.html/.js/.css   # SVG ring + label renderer
  src/panel.html/.js/.css     # reply card + confirm buttons
  config.json             # see 4.5
  test/jsonfix.test.js    # node:test + assert, one test file
```

## 8. macOS permissions (fail loudly, not silently)

- Screen Recording -> desktopCapturer (capture fails to black/empty otherwise)
- Accessibility -> System Events (click/type)

Startup self-check: attempt a 1px test capture through the same code path; on
failure or empty frame, panel shows:
"Grant Screen Recording & Accessibility in System Settings > Privacy & Security"
with a button that runs:
`open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"`

Failed silently = the app "works" but draws nothing. This is the #1
support-failure mode; the self-check is 10 lines and kills it.

## 9. Phase 2 (voice) — trigger swap only

- TTS: `say` (macOS builtin, zero deps)
- STT: whisper.cpp local or Groq whisper-large-v3-turbo (free tier), push-to-talk hotkey
- Same pipeline; the trigger changes from "hotkey" to "hotkey + audio buffer"

## 10. Latency budget (stated, not assumed)

| step | cost |
|------|------|
| capture + jpeg encode | ~150ms |
| provider round trip | 1-2.5s cloud, 1-4s local |
| parse + render | <50ms |
| **total** | **~1.5-3s per query** |

That is not "real-time voice" — it is a fast command loop. Voice chat with
streaming is a different product; not v1.

## 11. Testing (one file)

`test/jsonfix.test.js` (node:test + assert, stdlib):
- stripped fenced JSON ```json {..}```
- JSON with trailing prose after `}`
- invalid JSON containing `"intent":"CLICK"` -> regex recovery returns intent
- coordinate math: `(x/1000)*bounds` with x=1000, x=0, mixed-DPI case

`ponytail: this is the only non-trivial pure logic in the app; the rest is
glue and gets verified by running it.`