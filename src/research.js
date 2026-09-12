'use strict';

// Zero-dep web research: DuckDuckGo HTML (no key needed), extract top
// result titles+snippets, return them for the LLM to answer from.
// (ponytail: DDG HTML scraping is brittle; swap to a real search API when
// this becomes a product. For personal use it's fine.)

async function search(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000); // DDG can hang — bound it
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'deskmate/1.0' }, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw Object.assign(new Error('search timed out'), { code: 'E_SEARCH' });
    throw Object.assign(new Error(`research ${e.message}`), { code: 'E_SEARCH' });
  }
  clearTimeout(timer);
  if (!res.ok) throw Object.assign(new Error(`research ${res.status}`), { code: 'E_SEARCH' });
  const html = await res.text();

  // Pull result blocks: <a class="result__a" ...>title</a> ... snippet
  const results = [];
  const blockRe = /<a[^>]*class="result__a"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/g;
  let m;
  while ((m = blockRe.exec(html)) && results.length < 5) {
    const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").trim();
    results.push({ title: strip(m[1]), snippet: strip(m[2]) });
  }
  if (!results.length) return ''; // no parseable results — LLM falls back to its own knowledge
  return results.map((r, i) => `${i + 1}. ${r.title}: ${r.snippet}`).join('\n');
}

module.exports = { search };