'use strict';

const INTENTS = ['HIGHLIGHT', 'CLICK', 'TYPE', 'KEYS', 'ANSWER', 'OPEN', 'PLAY', 'STOP', 'MAIL'];

// Any negative coerces to -1 (the "not applicable" sentinel); 0..1000 clamps to range.
const clamp = (n) => {
  n = Math.round(Number(n));
  if (!Number.isFinite(n) || n < 0) return -1;
  return Math.min(1000, n);
};
const s = (v, max) => String(v ?? '').trim().slice(0, max);

function normalize(o) {
  o = o || {};
  const intent = String(o.intent || '').toUpperCase();
  if (!INTENTS.includes(intent)) {
    throw Object.assign(new Error(`unknown intent "${intent.slice(0, 20)}"`), { code: 'E_PARSE' });
  }
  return {
    intent,
    x: clamp(o.x),
    y: clamp(o.y),
    label: s(o.label, 120),
    text: s(o.text, 500),
    keys: s(o.keys, 40),
    url: s(o.url, 512),
    reply: s(o.reply, 1000),
    followUp: s(o.followUp, 200),
    taskComplete: !!o.taskComplete,
  };
}

// Recover valid JSON from real LLM output: fences, prose wrappers,
// trailing chatter, and partial objects. Falls back to regex scanning
// for the fields we actually consume.
function parse(raw) {
  let t = String(raw ?? '').trim();
  if (!t) throw Object.assign(new Error('empty model output'), { code: 'E_PARSE' });

  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);

  try {
    return normalize(JSON.parse(t));
  } catch { /* fall through to regex recovery */ }

  const g = (k) => {
    const m = t.match(new RegExp(`["']?${k}["']?\\s*[:=]\\s*"([^"]*)"`));
    return m ? m[1] : '';
  };
  const gn = (k) => {
    const m = t.match(new RegExp(`["']?${k}["']?\\s*[:=]\\s*(-?\\d+)`));
    return m ? clamp(m[1]) : -1;
  };

  return normalize({
    intent: g('intent'),
    x: gn('x'),
    y: gn('y'),
    label: g('label'),
    text: g('text'),
    keys: g('keys'),
    url: g('url'),
    reply: g('reply'),
    followUp: g('followUp'),
    taskComplete: /taskComplete"?\s*[:=]\s*true/i.test(t),
  });
}

module.exports = { parse, normalize, INTENTS };