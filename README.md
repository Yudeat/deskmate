# deskmate

A macOS screen assistant. Press a hotkey, ask a question or give a command about
whatever's on your screen — deskmate sees it, answers, draws a ring around
things it points at, and can click / type / press keys on your behalf.

Single user. Bring your own API key. No server, no accounts, no tracking.

## What it does

- **See your screen** — captures the display under your cursor, downscales, sends to a vision model
- **Answer** — ask about anything visible ("what's this error? summarize this page")
- **Annotate** — draws a ring + label on screen around what it's talking about
- **Act** — clicks, types, and presses key combos — but always asks you to confirm first
- **Multi-step tasks** — "create an API key" actually works: it clicks, re-checks the screen, proposes the next step, loops up to 3 steps, and stops when the task's done (or asks you if it gets stuck)
- **Remembers** — an append-only log of every ask/action; recent context is fed back into follow-ups
- **Chat mode** — press the hotkey once; the panel stays open and keeps accepting questions. No hotkey spam.

## Setup

1. `npm install`
2. `mkdir -p ~/.deskmate && cp config.example.json ~/.deskmate/config.json`
3. Put your API key in `~/.deskmate/config.json` — or set provider to `ollama` for fully local (no key)
4. `npm start`
5. Grant **Screen Recording** + **Accessibility** when macOS asks (System Settings > Privacy & Security)
6. Press `Cmd+Shift+Space`, type a request, hit Ask or Enter

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
- **Local:** set `"provider": "ollama"`, `ollama pull minicpm-v`, leave key blank.

Your key never touches a server you don't own, and is never written into code or the repo.

### 4. Run it

```bash
npm start
```

### 5. First-run permissions (macOS)

Two permissions, granted per app-binary — both required:
1. **Screen Recording** — so it can see your screen
2. **Accessibility** — so it can click / type / press keys

If you hit "osascript is not allowed assistive access," click the panel's **Open System Settings**, enable the toggle, then **quit deskmate completely and relaunch** (TCC only applies on a full restart).

### 6. Try it

Press **Cmd+Shift+Space**, type any question about the screen, hit Enter.

Good first tries: "Summarize my screen" · "What's this error?" · "Create an API key"

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Screen Recording permission is not granted" | enable it, relaunch |
| "osascript is not allowed assistive access" | Accessibility toggle, relaunch |
| Hotkey does nothing | re-focus the app, press the hotkey again |
| Vision 404 | model retired — use default gemini-3.6-flash |
| Vision 429 | free-tier rate limit — wait or switch provider |

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
  "overlayMs": 6000
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

## Memory

Every ask/action is appended, one JSON line each, to `memory.jsonl`:

```json
{"ts":"2026-09-08T09:41Z","app":"Figma","req":"select the frame tool","reply":"Click the Frame tool top-left","intent":"HIGHLIGHT","step":0}
```

The last N entries (`memoryTail`) are injected into the next prompt, so follow-ups
know what you were working on. No database, no vector store — just a log file you
can grep. Delete it any time to reset.

## Future (roadmap)

deskmate is built to grow in phases. None of this exists yet — it's the plan.

### v2 — Voice, richer memory

- **Voice input** — talk instead of type (Groq Whisper or local whisper.cpp); hotkey becomes push-to-talk
- **Voice output** — replies spoken aloud (macOS `say`, no deps), on/off toggle
- **Screen-delta awareness** — capture-on-demand today; v2 notices when visible content *meaningfully changes* (cheap diffs) and reacts
- **Smarter memory** — the JSONL log gains lightweight "what was I doing yesterday?" queries (no database); periodic one-line summaries keep long-term context relevant
- **Windows support** — same Electron shell, swap osascript/System Events for PowerShell/UIAutomation

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
- Actions (CLICK/TYPE/KEYS) always require an in-app **confirm** before executing
- Missing permissions surface as a dialog with an Open Settings button — never a silent failure
- TCC denials are detected even when macOS reports them on stdout instead of stderr

## Controls

- `Cmd+Shift+Space` — open the assistant
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
- Not a background voice assistant (that's a phase-2 idea); it's a hotkey-triggered agent