'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROVIDERS = ['gemini', 'groq', 'ollama', 'openrouter'];

const DEFAULTS = {
  hotkey: 'Cmd+Shift+Space',
  provider: 'gemini',
  model: 'gemini-3.6-flash',
  apiKey: '',
  memoryEnabled: true,
  memoryTail: 20,
  memoryPath: '~/.deskmate/memory.jsonl',
  overlayMs: 6000,
  ttsEnabled: true,
  wakeEnabled: true,
  wakeWord: 'deskmate',
  wakeModel: '/opt/homebrew/share/whisper.cpp/models/ggml-base.en.bin',
  visionModel: 'minicpm-v', // separate from cfg.model (text): vision needs a multimodal model
  wakeCapture: 1,
  wakeCommandMs: 6000,
};

function configPath() {
  return path.join(os.homedir(), '.deskmate', 'config.json');
}

function loadConfig() {
  const p = configPath();
  let file = {};
  if (fs.existsSync(p)) {
    try {
      file = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      throw Object.assign(new Error(`config.json is not valid JSON: ${e.message}`), { code: 'E_CONFIG' });
    }
  }
  const cfg = { ...DEFAULTS, ...file };
  if (!PROVIDERS.includes(cfg.provider)) {
    throw Object.assign(new Error(`provider must be one of ${PROVIDERS.join(', ')}`), { code: 'E_CONFIG' });
  }
  if (cfg.provider !== 'ollama' && !cfg.apiKey) {
    throw Object.assign(new Error('apiKey missing - copy config.example.json to ~/.deskmate/config.json and add your key'), { code: 'E_CONFIG' });
  }
  if (typeof cfg.hotkey !== 'string' || !cfg.hotkey.includes('+')) {
    throw Object.assign(new Error('hotkey must be an Electron accelerator like "Cmd+Shift+Space"'), { code: 'E_CONFIG' });
  }
  return cfg;
}

module.exports = { loadConfig, configPath, DEFAULTS, PROVIDERS };