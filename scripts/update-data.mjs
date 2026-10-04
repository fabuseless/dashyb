#!/usr/bin/env node
// Collects AI news, model releases and community posts into data/snapshot.json.
// No dependencies; needs Node 20+. Run: node scripts/update-data.mjs
// Each source is fetched independently so one failure never blocks the rest.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFeed, collectModels, collectHN, collectReddit, collectBluesky, collectHF } from '../assets/collect.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'snapshot.json');
const UA = 'Mozilla/5.0 (compatible; dashyb-ai-dashboard/1.0; +https://github.com/fabuseless/dashyb)';

const config = JSON.parse(await readFile(join(ROOT, 'config', 'sources.json'), 'utf8'));
const status = {};

async function get(url, { json = false } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: json ? 'application/json' : '*/*' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return json ? res.json() : res.text();
}

async function track(name, fn) {
  try {
    const v = await fn();
    status[name] = { ok: true, count: Array.isArray(v) ? v.length : undefined };
    return v;
  } catch (e) {
    status[name] = { ok: false, error: String(e.message || e).slice(0, 200) };
    console.warn(`! ${name}: ${status[name].error}`);
    return null;
  }
}

let previous = {};
try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch {}

const [feeds, models, hn, reddit, bluesky, hf] = await Promise.all([
  Promise.all(config.feeds.map((f) => track(`feed:${f.id}`, () => collectFeed(f, get)))),
  track('openrouter', () => collectModels(config, get)),
  track('hackernews', () => collectHN(config, get)),
  track('reddit', () => collectReddit(config, get)),
  track('bluesky', () => collectBluesky(config, get)),
  track('huggingface', () => collectHF(config, get)),
]);

// A feed that failed this run keeps its items from the previous snapshot.
const news = config.feeds.flatMap((f, i) => feeds[i] ?? (previous.news || []).filter((n) => n.sourceId === f.id));
const seen = new Set();
const dedupedNews = news
  .filter((n) => (seen.has(n.link) ? false : seen.add(n.link)))
  .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

const keep = (fresh, key, empty) => fresh ?? previous[key] ?? empty;
const snapshot = {
  generatedAt: new Date().toISOString(),
  status,
  news: dedupedNews,
  models: keep(models, 'models', []),
  hn: keep(hn, 'hn', []),
  reddit: keep(reddit, 'reddit', []),
  bluesky: keep(bluesky, 'bluesky', []),
  hf: keep(hf, 'hf', { models: [], papers: [] }),
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(snapshot));
const ok = Object.values(status).filter((s) => s.ok).length;
console.log(`Wrote data/snapshot.json: ${snapshot.news.length} news, ${snapshot.models.length} models, ${snapshot.hn.length} HN, ${snapshot.reddit.length} reddit, ${snapshot.bluesky.length} bluesky (${ok}/${Object.keys(status).length} sources ok)`);
