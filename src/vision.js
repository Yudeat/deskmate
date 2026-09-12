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
        // stream:true — Ollama sends progressive token lines. Chromium's
        // fetch aborts a connection that idles ~60s waiting for the ONE
        // big response (stream:false) from a slow local vision model.
        // Streaming keeps the socket active and works in Electron.
        body: { model, stream: true, format: 'json', messages: [{ role: 'user', content: prompt, images: [b64] }] },
        extract: (d) => d.message?.content || '',
      };
    }
    default:
      throw Object.assign(new Error(`provider ${cfg.provider}`), { code: 'E_CONFIG' });
  }
}

async function infer(cfg, request, b64, mime, mem) {
  const { url, headers, body, extract } = build(cfg, request, b64, mime, mem);
  const timeoutMs = cfg.provider === 'ollama' ? 240000 : 30000;
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

  // Ollama with stream:true → NDJSON lines; join all message deltas.
  // Hold the abort timer across the whole read (stalled streams must die,
  // or they monopolize Ollama's single-request queue forever).
  if (body.stream) {
    const text = await readNdjson(res.body, ctrl);
    clearTimeout(timer);
    if (!text) throw Object.assign(new Error('empty model response'), { code: 'E_PARSE' });
    return text;
  }
  clearTimeout(timer);
  const data = await res.json();
  const text = extract(data);
  if (!text) throw Object.assign(new Error('empty model response'), { code: 'E_PARSE' });
  return text;
}

// Reads an NDJSON response body (Ollama stream:true) and joins the
// message deltas into one string. Keeps consuming lines as they arrive,
// which is what resets Chromium's idle timer. ctrl (optional) is the
// abort controller — on timeout the reader is cancelled so the fetch
// actually dies (not just the timer).
async function readNdjson(stream, ctrl) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let out = '';
  let aborted = false;
  if (ctrl) ctrl.signal.addEventListener('abort', () => { aborted = true; reader.cancel(); });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (aborted) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const d = JSON.parse(line);
          if (d.message && typeof d.message.content === 'string') out += d.message.content;
          if (d.done) return out;
        } catch { /* partial line — skip */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

module.exports = { infer, transcribe, researchAnswer };

// v2.1: text-only research answer. The user asked a general/world question
// ("weather today", "capital of France") — no screenshot. Search results are
// injected as context; the model answers from those + its knowledge. Reuses
// the same providers with a text-only body.
async function researchAnswer(cfg, request, searchResults) {
  const context = searchResults
    ? `WEB SEARCH RESULTS (use these to answer, cite them):\n${searchResults}`
    : 'WEB SEARCH returned nothing — answer from your knowledge.';
  const system = 'You are deskmate, a helpful assistant. Answer the user\'s question using the web search results when relevant. Be concise (1-3 sentences) and accurate. Reply with ONLY valid JSON: {"intent":"ANSWER","x":-1,"y":-1,"label":"","text":"","keys":"","reply":"<your answer>","followUp":""}.';
  const prompt = `${system}\n\n${context}\n\nUSER QUESTION:\n${request}`;

  switch (cfg.provider) {
    case 'gemini': {
      const model = cfg.model || 'gemini-3.6-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
      const body = { contents: [{ parts: [{ text: prompt }] }] };
      return await postJson(url, { 'Content-Type': 'application/json' }, body, (d) => (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(''));
    }
    case 'groq':
    case 'openrouter': {
      const model = cfg.provider === 'groq' ? (cfg.model || 'llama-3.3-70b-versatile') : (cfg.model || 'openrouter/free');
      const url = cfg.provider === 'groq' ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` };
      const body = { model, temperature: 0, messages: [{ role: 'user', content: prompt }] };
      return await postJson(url, headers, body, (d) => d.choices?.[0]?.message?.content || '');
    }
    case 'ollama': {
      const model = cfg.model || 'llama3.2';
      const body = { model, stream: true, format: 'json', messages: [{ role: 'user', content: prompt }] };
      return await postJson('http://localhost:11434/api/chat', { 'Content-Type': 'application/json' }, body, (d) => d.message?.content || '', 240000, true);
    }
    default:
      throw Object.assign(new Error(`provider ${cfg.provider}`), { code: 'E_CONFIG' });
  }
}

async function postJson(url, headers, body, extract, timeoutMs = 30000, streamMode = false) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    throw Object.assign(new Error(`network error: ${e.message}`), { code: 'E_VISION' });
  }
  clearTimeout(timer);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw Object.assign(new Error(`${detail || res.status}`), { code: 'E_VISION' });
  }
  // streamMode: Ollama stream:true → NDJSON deltas (keeps Chromium's
  // socket alive during slow local inference).
  if (streamMode) {
    // Keep the abort timer alive through the WHOLE body read — clearing it
    // at headers lets a stalled stream hang forever and monopolize Ollama's
    // single-request queue (seen live: app request blocked all others).
    const text = await readNdjson(res.body, ctrl);
    clearTimeout(timer);
    if (!text) throw Object.assign(new Error('empty model response'), { code: 'E_PARSE' });
    return text;
  }
  clearTimeout(timer);
  const data = await res.json();
  const text = extract(data);
  if (!text) throw Object.assign(new Error('empty model response'), { code: 'E_PARSE' });
  return text;
}

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