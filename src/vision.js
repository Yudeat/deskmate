'use strict';

const { SYSTEM, buildUserPrompt } = require('./prompt');

function build(cfg, request, b64, mime, mem) {
  const prompt = `${SYSTEM}\n\n${buildUserPrompt(request, mem)}`;
  switch (cfg.provider) {
    case 'gemini': {
      const model = cfg.model || 'gemini-3.6-flash';
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`,
        headers: { 'Content-Type': 'application/json' },
        body: { contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }] },
        extract: (d) => (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(''),
      };
    }
    case 'groq': {
      const model = cfg.model || 'llama-3.2-11b-vision-preview';
      return {
        url: 'https://api.groq.com/openai/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: {
          model,
          temperature: 0,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
            ],
          }],
        },
        extract: (d) => d.choices?.[0]?.message?.content || '',
      };
    }
    case 'openrouter': {
      // OpenAI-compatible: same shape as groq, different base URL + authed model.
      const model = cfg.model || 'openrouter/free'; // free router: auto-picks a free vision-capable model
      return {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
          'HTTP-Referer': 'https://github.com/deskmate',      // identifies the app; safe constant
          'X-OpenRouter-Title': 'deskmate',                    // same
        },
        body: {
          model,
          temperature: 0,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
            ],
          }],
        },
        extract: (d) => d.choices?.[0]?.message?.content || '',
      };
    }
    case 'ollama': {
      const model = cfg.model || 'minicpm-v';
      return {
        url: 'http://localhost:11434/api/chat',
        headers: { 'Content-Type': 'application/json' },
        body: { model, stream: false, format: 'json', messages: [{ role: 'user', content: prompt, images: [b64] }] },
        extract: (d) => d.message?.content || '',
      };
    }
    default:
      throw Object.assign(new Error(`provider ${cfg.provider}`), { code: 'E_CONFIG' });
  }
}

async function infer(cfg, request, b64, mime, mem) {
  const { url, headers, body, extract } = build(cfg, request, b64, mime, mem);
  const timeoutMs = cfg.provider === 'ollama' ? 60000 : 30000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw Object.assign(new Error(`${cfg.provider} timed out after ${timeoutMs / 1000}s`), { code: 'E_VISION' });
    }
    throw Object.assign(new Error(`network error: ${e.message}`), { code: 'E_VISION' });
  }
  clearTimeout(timer);

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    if (res.status === 429) {
      throw Object.assign(new Error('rate limited (429) - wait a moment or switch provider'), { code: 'E_VISION' });
    }
    if (res.status === 400 || res.status === 401) {
      throw Object.assign(new Error(`provider rejected the request (${res.status}): ${detail}`), { code: 'E_VISION' });
    }
    throw Object.assign(new Error(`vision ${res.status}: ${detail}`), { code: 'E_VISION' });
  }

  const data = await res.json();
  const text = extract(data);
  if (!text) throw Object.assign(new Error('empty model response'), { code: 'E_PARSE' });
  return text;
}

module.exports = { infer };

// v2: speech-to-text via the SAME provider key the user already has.
// Groq's transcription endpoint (whisper) needs no extra signup. WAV buffer.
async function transcribe(cfg, wavBuffer) {
  if (!cfg.apiKey) {
    throw Object.assign(new Error('Voice input needs an API key in config'), { code: 'E_STT' });
  }
  const { Blob, FormData } = await import('node:buffer'); // not global in Electron main
  const model = cfg.sttModel || 'whisper-large-v3-turbo';
  const fd = new FormData();
  fd.append('model', model);
  fd.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'voice.wav');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: fd,
  });
  if (!res.ok) {
    throw Object.assign(new Error(`stt ${res.status}: ${(await res.text()).slice(0, 200)}`), { code: 'E_STT' });
  }
  const data = await res.json();
  return (data.text || '').trim();
}