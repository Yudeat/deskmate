# deskmate

A macOS screen assistant that lives in your ear and on your desktop — voice-first, private, single-user. Say **"deskmate"** and it wakes up, or press the hotkey and type. It can see your screen, answer questions, act on your behalf (click / type / press keys / open apps / play music), and it speaks back.

Single user. Bring your own API key. No server, no accounts, no tracking.

## What it does

- **Wake word** — say "deskmate" and it answers (voice input via whisper.cpp, no hotkey needed)
- **Speaks back** — replies are spoken aloud (macOS `say`, zero deps); toggle off if you prefer text
- **Voice commands** — "deskmate, what's the time?", "deskmate, open gmail", "play shape of you" — all spoken, no typing
- **See your screen** — captures the display under your cursor, downscales, sends to a vision model
- **Answer** — ask about anything visible ("what's this error? summarize this page")
- **Act** — clicks, types, presses key combos, opens URLs/apps, plays music — **direct action mode** (no confirm prompt): "just do it"
- **Play music** — "deskmate, play shape of you" → resolves the top YouTube result via `yt-dlp` and plays the *audio* stream in `mpv` (no browser, no search page)
- **Remembers** — append-only JSONL log of every ask/action; recent context feeds back into follow-ups
- **Chat mode** — press the hotkey once; the panel stays open for follow-ups. No hotkey spam.

## Voice model

```
asleep (default) ── wake word ("deskmate") or hotkey ──► awake
   ▲                                                      │
   └── "sleep" / "go to sleep" / "deskmate sleep" ◄───────┘
```

- **Asleep** (default): only the wake word activates it. Bare speech is ignored.
- **Awake**: every spoken line is a command; the wake word is stripped if present. Say "sleep" to put it back to sleep (it ack's "Bye").
- One whisper daemon serves both states — no process gap when waking.
- The wake-word matcher is deliberately loose (edit-distance ≤2 + acoustic spellings like "Decimate", "desk mate", "thanks mate"), so your real voice is recognized without exact matches. False positives just show the panel; false negatives kill the feature.
- Background noise cue like "(water rushing)" / "[Start speaking]" are dropped before the state machine — they never fire commands, whether awake or asleep.

## Setup

1. `npm install`
2. `mkdir -p ~/.deskmate && cp config.example.json ~/.deskmate/config.json`
3. Put your API key in `~/.deskmate/config.json` — or set provider to `ollama` for fully local (no key)
4. `npm start`
5. Grant **Screen Recording** + **Accessibility** + **Microphone** when macOS asks (System Settings > Privacy & Security)
6. Press `Cmd+Shift+Space`, type a request, hit Ask or Enter — or just say **"deskmate, what is the time?"**

## Install (detailed)

### Prerequisites

- macOS (any modern version)
- [Node.js](https://nodejs.org) 18 or newer
- npm (ships with Node)
- One of: a free [Google AI Studio](https://aistudio.google.com) Gemini key · a free [Groq](https://console.groq.com) key · an [OpenRouter](https://openrouter.ai) key · or [Ollama](https://ollama.com) for fully offline

### 1. Get the code

```bash
git clone <your-repo-url> deskmate
cd deskmate
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure your key

```bash
mkdir -p ~/.deskmate
cp config.example.json ~/.deskmate/config.json
```

Open `~/.deskmate/config.json` and set `"apiKey"`:
- **Gemini (recommended):** [Google AI Studio](https://aistudio.google.com) → Get API key → Create. Free tier is generous.
- **Groq:** [console.groq.com](https://console.groq.com) → API Keys
- **OpenRouter:** [openrouter.ai/keys](https://openrouter.ai/keys)
- **Local:** set `"provider": "ollama"`, `ollama pull llama3.2`, leave key blank.

Your key never touches a server you don't own, and is never written into code or the repo.

### 4. Run it

```bash
npm start
```

### 5. First-run permissions (macOS)

Three permissions, granted per app-binary — all required for full function:
1. **Screen Recording** — so it can see your screen
2. **Accessibility** — so it can click / type / press keys
3. **Microphone** — so the wake word can hear you

If you hit "osascript is not allowed assistive access," click the panel's **Open System Settings**, enable the toggle, then **quit deskmate completely and relaunch** (TCC only applies on a full restart).

### 6. Try it

Press **Cmd+Shift+Space**, type any question about the screen, hit Enter — or just say **"deskmate, what is the time?"**

Good first tries: "deskmate, what is the time?" · "deskmate, open gmail" · "deskmate, play shape of you" · "Summarize my screen" · "What's this error?"

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Screen Recording permission is not granted" | enable it, relaunch |
| "osascript is not allowed assistive access" | Accessibility toggle, relaunch |
| Hotkey does nothing | re-focus the app, press the hotkey again |
| Wake word isn't heard | raise **input volume** (System Settings → Sound → Input, or `osascript -e 'set volume input volume 85'`); check the mic device; watch the log for `[wake] heard:` |
| Background music/noise fires commands | noise cues are auto-dropped; wake matcher requires a d-sound word at edit-distance ≤2 |
| Vision 404 | model retired — use default gemini-3.6-flash |
| Vision 429 | free-tier rate limit — wait, or switch provider / use ollama |
| "play X" opens search instead of playing | mpv + yt-dlp must be installed (`brew install mpv yt-dlp`); `-f bestaudio` forces the audio stream |

## Providers

The app never hardcodes a key — it reads `~/.deskmate/config.json` (gitignored).

| provider | model (default) | key needed | notes |
|---|---|---|---|
| gemini | gemini-3.6-flash | Yes (free tier) | primary, best vision |
| groq | llama-3.2-11b-vision-preview | Yes (free tier) | faster, lighter |
| openrouter | openrouter/free | Yes | one key = many models; pin with a slug like `meta-llama/llama-3.2-11b-vision-instruct:free` |
| ollama | minicpm-v | No | localhost:11434, offline, private |

Switch providers by changing `"provider"` in config.json. Ollama needs `ollama
serve` running with the model pulled.

For **text-only command routing** (the "just do it" direct-action path), ollama uses `llama3.2` — small, fast (~4s), no key. Vision (minicpm-v) is slower on Apple Silicon (3–4 min per image) — hardware-bound, works but best used on-demand.

## Config

All config lives in `~/.deskmate/config.json` (copy of `config.example.json`):

```json
{
  "hotkey": "Cmd+Shift+Space",
  "provider": "gemini",
  "model": "gemini-3.6-flash",
  "apiKey": "",
  "memoryEnabled": true,
  "memoryTail": 20,
  "memoryPath": "~/.deskmate/memory.jsonl",
  "overlayMs": 6000,
  "ttsEnabled": true,
  "wakeEnabled": true,
  "wakeWord": "deskmate",
  "wakeModel": "/opt/homebrew/share/whisper.cpp/models/ggml-base.en.bin",
  "wakeCommandMs": 6000
}
```

| key | default | purpose |
|---|---|---|
| hotkey | Cmd+Shift+Space | Electron accelerator |
| provider | gemini | gemini / groq / openrouter / ollama |
| model | gemini-3.6-flash | override per provider |
| apiKey | "" | required except ollama |
| memoryEnabled | true | append queries to the memory log |
| memoryTail | 20 | how many past entries feed back as context |
| memoryPath | ~/.deskmate/memory.jsonl | the append-only log |
| overlayMs | 6000 | how long the ring stays on screen |
| ttsEnabled | true | speak replies aloud (macOS say) |
| wakeEnabled | true | run the wake-word listener on boot |
| wakeWord | deskmate | the wake word (acoustic variants like "Decimate"/"desk mate" auto-match) |
| wakeModel | ggml-base.en.bin | whisper.cpp model path (default 142MB base.en; tiny.en is lighter/faster) |
| wakeCommandMs | 6000 | how long a spoken command window stays open |

## Direct-action mode

v2's "no screenshot unless asked" design: when you say a command (not a screen question), deskmate routes through a **text-only fast model** that returns a structured intent — `PLAY`, `OPEN`, `TYPE`, `KEYS`, `ANSWER` — and executes it directly, no confirmation:

- **PLAY** — "play shape of you" → `yt-dlp -f bestaudio ytsearch1:<q>` → mpv plays the audio stream
- **OPEN** — "open gmail" → `/usr/bin/open` with the URL
- **TYPE / KEYS** — type text or press a key combo
- **ANSWER** — responded to directly with speech

No screenshot is taken unless you explicitly ask about the screen ("what's on my screen", "summarize the content here").

## Memory

Every ask/action is appended, one JSON line each, to `memory.jsonl`:

```json
{"ts":"2026-09-08T09:41Z","app":"Figma","req":"select the frame tool","reply":"Click the Frame tool top-left","intent":"HIGHLIGHT","step":0}
```

The last N entries (`memoryTail`) are injected into the next prompt, so follow-ups
know what you were working on. No database, no vector store — just a log file you
can grep. Delete it any time to reset.

## Future (roadmap)

deskmate is built to grow in phases. Beyond v2:

### v3 — Autonomy & open ecosystem

- **Verified task execution** — after each action, confirm it actually worked via the accessibility tree before proceeding (kills stuck-loop cases for good)
- **Self-healing multi-step plans** — agent plans several steps, executes, adapts when a step fails — not stopping at the first error
- **Custom app skills** — per-app instruction sets ("in Figma, use these shortcuts") so it acts idiomatically
- **Local-first default** — Ollama the default; cloud only when you opt in
- **Plugin hooks** — simple plugin API for actions/triggers/integrations without forking
- **Scheduled agents** — "every morning at 9, summarize my inbox," powered by memory + vision

### v4+ (stretch, not promised)

- Multi-modal local models (transcription + vision + reasoning all on-device)
- Cross-device memory sync (encrypted, self-hosted)
- Screen-scrape → structured data ("turn this dashboard into a CSV")

The north star stays the same through every phase: **a fast, private, single-user assistant that lives on your desktop, knows your screens, and acts with your permission** — not another cloud chat window.

## Security model

- API key lives only in `~/.deskmate/config.json` (outside the repo, gitignored)
- Renderers: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`
- osascript: free text travels as argv data (never concatenated into a script — no AppleScript injection); key combos whitelist-parsed; coordinates validated integers
- URLs passed to `/usr/bin/open` are scheme-guarded (`^[a-z][a-z0-9+.-]*://`) and reject angle brackets
- Playback queries are argv-escaped (never shell-concatenated); mpv/yt-dlp spawn clean
- Actions are direct-execute by design (your voice is the authorization) — no remote, no accounts
- Missing permissions surface as a dialog with an Open Settings button — never a silent failure
- TCC denials are detected even when macOS reports them on stdout instead of stderr

## Controls

- `Cmd+Shift+Space` — open the assistant (also wakes it from asleep)
- Say **"deskmate"** — wake it (voice)
- Say **"deskmate, <command>"** — wake + command in one line
- Say **"sleep"** / **"go to sleep"** — put it back to sleep (ack "Bye")
- `Enter` — ask
- `Esc` — close / cancel
- **Ask** — submit a request
- **Do it** — confirm a suggested action (click / type / keys)
- **Copy** — copy the reply

## Tech

- Electron + plain Node (no bundler, no framework, no build step)
- 100% vanilla HTML/CSS/JS renderer
- Node built-in `fetch` + JSON — zero SDKs
- osascript / System Events for click, type, keys (macOS native)
- whisper.cpp (`whisper-stream`) for continuous wake-word transcription — no cloud STT
- macOS `say` for speech output — no cloud TTS
- mpv + yt-dlp for music playback (resolves the top YouTube result's audio stream)
- append-only JSONL for memory
- node:test + assert for the test suite

## Test

```bash
npm test
```

## Limitations (honest)

- The screen is captured on-demand (hotkey/ask), not continuously — it can't "watch" live changes by itself
- Coordinate accuracy is model-driven; for precise clicks, expect to confirm
- Multi-step loops are capped at 3 steps with a stuck-loop guard — complex flows may need you to steer
- Wake-word accuracy is tuned to real voice via a loose matcher; if whisper hears a new spelling, add it to `base` in `src/wake.js`
- Local vision (ollama minicpm-v) is slow on Apple Silicon (3–4 min/image) — hardware-bound, not a code bug
- Ollama's single-request queue means one slow request blocks others