// Dashboard front-end. Loads config + the scheduled snapshot, renders the current page,
// then refreshes the CORS-friendly sources (OpenRouter, Hacker News, Hugging Face, Reddit, Bluesky) live.
import { collectModels, collectHN, collectReddit, collectBluesky, collectHF } from './collect.js';

const page = document.body.dataset.page;
const state = { config: null, data: null, live: new Set(), ui: {} };

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const md = (s) => esc(String(s ?? '').replace(/\*\*|__/g, ''));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const ts = (d) => (d ? Date.parse(d) : 0);
const num = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : String(n ?? 0));
const ctx = (n) => (!n ? '—' : n >= 1e6 ? (n / 1048576 >= 0.98 ? Math.round(n / 1e6 * 10) / 10 : (n / 1e6).toFixed(2)) + 'M' : Math.round(n / 1000) + 'K');
const price = (p) => (p > 0 ? '$' + (p < 0.1 ? p.toFixed(3) : p < 10 ? p.toFixed(2) : p.toFixed(0)) : p === 0 ? 'free' : '—');
const ago = (d) => {
  const s = (Date.now() - ts(d)) / 1000;
  if (!d || isNaN(s)) return '';
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.round(s / 86400) + 'd ago';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
const shortDate = (d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const favicon = (u) => `https://www.google.com/s2/favicons?sz=32&domain=${host(u)}`;
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const DAY = 86400e3;

// ---------- shell ----------
const NAV = [
  ['overview', 'index.html', 'Overview'],
  ['models', 'models.html', 'Models'],
  ['news', 'news.html', 'News'],
  ['community', 'community.html', 'Community'],
  ['resources', 'resources.html', 'Go-to sites'],
];

function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const b = $('#theme-btn');
  if (b) b.textContent = t === 'light' ? '☀' : t === 'dark' ? '☾' : '◐';
}

function renderShell() {
  document.body.insertAdjacentHTML('afterbegin', `
    <header class="topbar"><div class="topbar-inner">
      <a class="brand" href="index.html"><span class="brand-mark">◆</span>AI Pulse</a>
      <nav class="nav">${NAV.map(([id, href, label]) => `<a href="${href}" class="${id === page ? 'active' : ''}">${label}</a>`).join('')}</nav>
      <div class="top-actions">
        <span class="updated" id="updated"><span class="live-dot"></span>Loading…</span>
        <button class="icon-btn" id="refresh-btn" title="Refresh live sources">↻</button>
        <button class="icon-btn" id="theme-btn" title="Theme: auto / light / dark">◐</button>
      </div>
    </div></header>`);
  document.body.insertAdjacentHTML('beforeend', `
    <footer>Data: <a href="https://openrouter.ai/models">OpenRouter</a>, lab & press RSS feeds, <a href="https://hn.algolia.com/api">Hacker News</a>,
    Reddit, Bluesky, <a href="https://huggingface.co">Hugging Face</a>. Snapshot rebuilt on a schedule by GitHub Actions; API sources also refresh live in your browser.
    Curated flagships live in <code>config/sources.json</code>.</footer>`);
  applyTheme(store.get('theme'));
  $('#theme-btn').onclick = () => {
    const order = [null, 'light', 'dark'];
    const next = order[(order.indexOf(store.get('theme')) + 1) % 3];
    store.set('theme', next ?? '');
    applyTheme(next);
  };
  $('#refresh-btn').onclick = () => refreshLive(true);
}

function updateStamp() {
  const el = $('#updated');
  if (!el || !state.data) return;
  const live = state.live.size;
  el.innerHTML = `<span class="live-dot ${live ? 'on' : ''}"></span>` +
    (live ? `Live · ${[...state.live].join(', ')}` : `Snapshot ${ago(state.data.generatedAt) || 'unavailable'}`);
  el.title = `Snapshot built ${state.data.generatedAt ? new Date(state.data.generatedAt).toLocaleString() : 'never'}`;
}

// ---------- data ----------
async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
const browserGet = async (url, { json } = {}) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return json ? r.json() : r.text();
};

async function refreshLive(force = false) {
  const btn = $('#refresh-btn');
  if (btn) btn.disabled = true;
  const cfg = state.config;
  const jobs = [
    ['models', 'OpenRouter', () => collectModels(cfg, browserGet), (v) => (state.data.models = v)],
    ['hn', 'HN', () => collectHN(cfg, browserGet, cfg.community.hnQueries.slice(0, page === 'community' ? 14 : 8)), (v) => (state.data.hn = v)],
    ['hf', 'HF', () => collectHF(cfg, browserGet), (v) => (state.data.hf = v)],
    ['reddit', 'Reddit', () => collectReddit(cfg, browserGet), (v) => (state.data.reddit = v)],
    ['bluesky', 'Bluesky', () => collectBluesky(cfg, browserGet), (v) => (state.data.bluesky = v)],
  ];
  // Snapshots under an hour old are fresh enough; skip the live round-trip unless asked.
  const fresh = Date.now() - ts(state.data.generatedAt) < 3600e3;
  await Promise.all(jobs.map(async ([key, label, run, set]) => {
    if (fresh && !force && state.data[key] && (Array.isArray(state.data[key]) ? state.data[key].length : true)) return;
    try {
      const v = await run();
      if (Array.isArray(v) && !v.length) return;
      set(v);
      state.live.add(label);
      render();
    } catch (e) {
      console.info(`live ${label} unavailable:`, e.message);
    }
  }));
  updateStamp();
  if (btn) btn.disabled = false;
}

// ---------- shared render pieces ----------
const providerModels = (p) => state.data.models.filter((m) => p.openrouter.includes(m.provider) && !/\b(batch|free|guard|safety|embed)/i.test(m.id));

function newerThanHeadline(p) {
  const latest = providerModels(p)[0];
  if (!latest) return null;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9.]/g, '');
  const headTime = Date.parse(p.headline.released);
  if (ts(latest.created) > headTime + 2 * DAY && !norm(latest.name).includes(norm(p.headline.name))) return latest;
  return null;
}

function providerCard(p) {
  const newer = newerThanHeadline(p);
  return `<a class="pcard" style="--pc:${p.color}" href="models.html#${p.id}">
    <div class="prov"><span class="dot"></span>${esc(p.name)}</div>
    <div class="model">${esc(p.headline.name)}</div>
    <div class="summary">${esc(p.headline.summary)}</div>
    ${newer ? `<div class="newer">New on API: ${esc(newer.name)} · ${ago(newer.created)}</div>` : ''}
    <div class="meta"><span>Released ${shortDate(p.headline.released)}${Date.now() - ts(p.headline.released) < 30 * DAY ? ` · ${ago(p.headline.released)}` : ''}</span></div>
  </a>`;
}

function newsItem(n, { showSummary = true } = {}) {
  const isNew = Date.now() - ts(n.date) < DAY;
  return `<li class="item"><img src="${favicon(n.link)}" alt="" width="16" height="16" style="margin-top:3px;border-radius:3px" loading="lazy">
    <div class="main"><a class="title" href="${esc(n.link)}" target="_blank" rel="noopener">${md(n.title)}</a>
    ${showSummary && n.summary ? `<div class="desc">${md(n.summary)}</div>` : ''}
    <div class="meta"><span class="src">${esc(n.source)}</span><span>${ago(n.date)}</span>${isNew ? '<span class="tag new">new</span>' : ''}</div></div></li>`;
}

const hnItem = (h) => `<li class="item"><div class="score" style="color:var(--hn)">${num(h.points)}<small>pts</small></div>
  <div class="main"><a class="title" href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a>
  <div class="meta"><span>${esc(host(h.url))}</span><a href="${esc(h.discussion)}" target="_blank" rel="noopener">${h.comments} comments</a><span>${ago(h.date)}</span></div></div></li>`;

const redditItem = (r) => `<li class="item"><div class="score" style="color:var(--reddit)">${num(r.score)}<small>votes</small></div>
  <div class="main"><a class="title" href="${esc(r.discussion)}" target="_blank" rel="noopener">${esc(r.title)}</a>
  <div class="meta"><span class="src">r/${esc(r.sub)}</span>${r.flair ? `<span class="tag">${esc(r.flair)}</span>` : ''}<span>${r.comments} comments</span><span>${ago(r.date)}</span></div></div></li>`;

const bskyItem = (p) => `<div class="post">
  <div class="who">${p.avatar ? `<img src="${esc(p.avatar)}" alt="" loading="lazy">` : '<span class="ph"></span>'}<b>${esc(p.author)}</b><span>@${esc(p.handle)}</span></div>
  <a class="body" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.text)}</a>
  <div class="meta"><span>♥ ${num(p.likes)}</span><span>⟲ ${num(p.reposts)}</span><span>💬 ${num(p.replies)}</span><span>${ago(p.date)}</span></div></div>`;

const paperItem = (p) => `<li class="item"><div class="score" style="color:var(--hf)">${p.upvotes}<small>votes</small></div>
  <div class="main"><a class="title" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
  ${p.summary ? `<div class="desc">${esc(p.summary)}</div>` : ''}</div></li>`;

const hfModelItem = (m) => `<li class="item"><div class="score" style="color:var(--hf)">${num(m.likes)}<small>likes</small></div>
  <div class="main"><a class="title" href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.id)}</a>
  <div class="meta">${m.task ? `<span class="tag">${esc(m.task)}</span>` : ''}<span>${num(m.downloads)} downloads</span><span>created ${ago(m.created)}</span></div></div></li>`;

const releaseRow = (m) => {
  const p = state.config.providers.find((p) => p.openrouter.includes(m.provider));
  return `<li><span class="when">${shortDate(m.created)}</span>
    <a class="name" href="https://openrouter.ai/${esc(m.id)}" target="_blank" rel="noopener" title="${esc(m.description)}">
      <span class="dot" style="--pc:${p?.color || 'var(--faint)'};margin-right:6px"></span>${esc(m.name)}${m.openWeights ? ' <span class="tag open">open</span>' : ''}</a>
    <span class="price">${ctx(m.context)} ctx · ${price(m.inPrice)}/${price(m.outPrice)}</span></li>`;
};

const empty = (msg) => `<div class="empty">${msg}</div>`;
const list = (items, fn, n, msg = 'Nothing here yet.') => (items?.length ? `<ul class="list">${items.slice(0, n).map(fn).join('')}</ul>` : empty(msg));

function tabs(id, defs, active) {
  return `<div class="tabs" data-tabs="${id}">${defs.map(([k, label, count]) =>
    `<button class="tab ${k === active ? 'active' : ''}" data-k="${k}">${label}${count != null ? `<span class="count">${count}</span>` : ''}</button>`).join('')}</div>`;
}
function bindTabs(root = document) {
  root.querySelectorAll('[data-tabs]').forEach((t) => {
    t.onclick = (e) => {
      const b = e.target.closest('.tab');
      if (!b) return;
      state.ui[t.dataset.tabs] = b.dataset.k;
      if (page === 'community') history.replaceState(null, '', '#' + b.dataset.k);
      render();
    };
  });
}

// ---------- pages ----------
function renderOverview() {
  const { data, config } = state;
  const week = data.models.filter((m) => Date.now() - ts(m.created) < 7 * DAY);
  const today = data.news.filter((n) => Date.now() - ts(n.date) < DAY);
  const topHN = data.hn[0];
  const ctab = state.ui.cpulse || 'hn';
  const ntab = state.ui.ntab || 'Labs';
  const newsFiltered = ntab === 'All' ? data.news : data.news.filter((n) => n.category === ntab);
  const recap = data.news.find((n) => n.sourceId === 'ainews');

  $('#app').innerHTML = `
    <div class="page-head"><div><h1>AI model pulse</h1>
      <p>Latest flagship models from every major lab, the headlines, and what the community is talking about, all in one place.</p></div></div>

    <div class="stats">
      <div class="stat"><div class="label">New API models · 7 days</div><div class="value">${week.length}</div><div class="hint">${week[0] ? 'Newest: ' + esc(week[0].name) : '—'}</div></div>
      <div class="stat"><div class="label">Headlines · 24 hours</div><div class="value">${today.length}</div><div class="hint">from ${new Set(today.map((n) => n.source)).size} of ${config.feeds.length} feeds</div></div>
      <div class="stat"><div class="label">Top HN story · 7 days</div><div class="value">${topHN ? num(topHN.points) : '—'}</div><div class="hint">${topHN ? esc(topHN.title) : ''}</div></div>
      <div class="stat"><div class="label">Trending on Hugging Face</div><div class="value">${data.hf?.models?.[0] ? num(data.hf.models[0].likes) : '—'}</div><div class="hint">${esc(data.hf?.models?.[0]?.id || '')}</div></div>
    </div>

    <section class="panel">
      <div class="panel-head"><h2>Latest flagship by provider</h2><span class="sub">${config.providers.length} labs · green badge = newer model just hit the API</span><a class="more" href="models.html">All models →</a></div>
      <div class="providers">${config.providers.map(providerCard).join('')}</div>
    </section>

    <div class="grid cols-3-2 section">
      <section class="panel">
        <div class="panel-head"><h2>Headlines</h2><a class="more" href="news.html">All news →</a></div>
        ${tabs('ntab', ['Labs', 'Newsletters', 'Press', 'All'].map((k) => [k, k]), ntab)}
        <div class="panel-body">${list(newsFiltered, (n) => newsItem(n), 9, 'No news yet. Run the updater.')}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Community pulse</h2><a class="more" href="community.html#${ctab}">Dive in →</a></div>
        ${tabs('cpulse', [['hn', 'Hacker News'], ['reddit', 'Reddit'], ['bluesky', 'Bluesky'], ['x', 'X recap']], ctab)}
        <div class="panel-body">${
          ctab === 'hn' ? list(data.hn, hnItem, 8)
          : ctab === 'reddit' ? list(data.reddit, redditItem, 8, 'Reddit is unreachable from this network right now. <a href="https://www.reddit.com/r/LocalLLaMA/top/?t=day" target="_blank" rel="noopener" style="color:var(--accent)">Open r/LocalLLaMA</a>')
          : ctab === 'bluesky' ? (data.bluesky?.length ? data.bluesky.slice(0, 6).map(bskyItem).join('') : empty('No Bluesky posts available.'))
          : xRecap(recap, 6)
        }</div>
      </section>
    </div>

    <div class="grid cols-2 section">
      <section class="panel">
        <div class="panel-head"><h2>Fresh API releases</h2><span class="sub">context · $ per 1M tokens in/out</span><a class="more" href="models.html#releases">Release table →</a></div>
        <div class="panel-body"><ul class="timeline">${data.models.filter((m) => !/\b(batch|free)/i.test(m.id)).slice(0, 12).map(releaseRow).join('')}</ul></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Trending research & open models</h2><a class="more" href="community.html#papers">More →</a></div>
        ${tabs('hftab', [['papers', 'HF daily papers'], ['hfmodels', 'Trending models']], state.ui.hftab || 'papers')}
        <div class="panel-body">${(state.ui.hftab || 'papers') === 'papers' ? list(data.hf?.papers, paperItem, 6) : list(data.hf?.models, hfModelItem, 8)}</div>
      </section>
    </div>

    <section class="panel section">
      <div class="panel-head"><h2>Go-to sites</h2><a class="more" href="resources.html">Full directory →</a></div>
      <div class="panel-body"><div class="links">${config.sites.flatMap((g) => g.items.slice(0, 4)).map((s) =>
        `<a class="chip" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.desc)}"><img src="${favicon(s.url)}" alt="" width="14" height="14" loading="lazy">${esc(s.name)}</a>`).join('')}</div></div>
    </section>`;
  bindTabs();
}

function xRecap(recap, n) {
  const accounts = state.config.xAccounts.slice(0, n * 2);
  return `<div class="note" style="margin:10px 0">X/Twitter doesn't offer free read access, so posts can't be pulled in directly.
    <b>AINews</b> summarises each day's top X, Reddit and Discord discussion, and the latest issue is below.</div>
    ${recap ? `<ul class="list">${newsItem(recap)}</ul>` : ''}
    <div class="links" style="margin-top:8px">${accounts.map((a) => `<a class="chip" href="https://x.com/${esc(a.handle)}" target="_blank" rel="noopener">@${esc(a.handle)}</a>`).join('')}
    <a class="chip" href="community.html#x">All accounts →</a></div>`;
}

function renderModels() {
  const { data, config } = state;
  const ui = (state.ui.models ||= { q: '', provider: 'all', open: false, days: '30', sort: 'created', dir: -1 });
  const provName = (m) => config.providers.find((p) => p.openrouter.includes(m.provider))?.name || m.provider;
  const cutoff = ui.days === 'all' ? 0 : Date.now() - +ui.days * DAY;
  const q = ui.q.toLowerCase();
  const rows = data.models
    .filter((m) => ts(m.created) >= cutoff && (ui.provider === 'all' || m.provider === ui.provider) && (!ui.open || m.openWeights)
      && (!q || (m.name + ' ' + m.id + ' ' + m.description).toLowerCase().includes(q)))
    .sort((a, b) => {
      const k = ui.sort, av = k === 'provider' ? provName(a) : a[k], bv = k === 'provider' ? provName(b) : b[k];
      return (av > bv ? 1 : av < bv ? -1 : 0) * ui.dir;
    });
  const providerIds = [...new Set(data.models.map((m) => m.provider))].sort();
  const th = (k, label, cls = '') => `<th class="${cls}" data-sort="${k}">${label}${ui.sort === k ? (ui.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`;

  $('#app').innerHTML = `
    <div class="page-head"><div><h1>Models</h1>
      <p>The flagship from each lab, with family members and official links. Below that is every model released on the OpenRouter API, refreshed live.</p></div>
      <div class="links">${config.providers.map((p) => `<a class="chip" href="#${p.id}"><span class="dot" style="--pc:${p.color}"></span>${esc(p.name)}</a>`).join('')}</div></div>

    <div class="grid cols-2">${config.providers.map((p) => {
      const ms = providerModels(p).slice(0, 5);
      const newer = newerThanHeadline(p);
      return `<section class="pdetail" id="${p.id}" style="--pc:${p.color}">
        <div class="pdetail-head"><span class="dot"></span><h2>${esc(p.name)}</h2>
          <a class="chip" href="https://x.com/${esc(p.x)}" target="_blank" rel="noopener" style="margin-left:auto">@${esc(p.x)}</a></div>
        <div class="headline-box">
          <div style="font-size:12px;color:var(--faint);font-weight:600">CURRENT FLAGSHIP · ${shortDate(p.headline.released)}, ${new Date(p.headline.released).getFullYear()}</div>
          <div class="model">${esc(p.headline.name)}</div>
          <div style="color:var(--muted);margin:4px 0 8px">${esc(p.headline.summary)}</div>
          <div class="links"><a class="chip active" href="${esc(p.headline.link)}" target="_blank" rel="noopener">Announcement →</a>
          ${p.family.map((f) => `<a class="chip" href="${esc(f.link)}" target="_blank" rel="noopener">${esc(f.name)}</a>`).join('')}</div>
        </div>
        ${newer ? `<div class="newer">Newer on the API: <b>${esc(newer.name)}</b> (${ago(newer.created)})</div>` : ''}
        <div><div style="font-size:12px;color:var(--faint);font-weight:600;margin-bottom:2px">LATEST API RELEASES</div>
          ${ms.length ? `<ul class="timeline">${ms.map(releaseRow).join('')}</ul>` : empty('Not listed on OpenRouter.')}</div>
        <div class="links">${Object.entries(p.links).map(([k, u]) => `<a class="chip" href="${esc(u)}" target="_blank" rel="noopener">${esc(k)}</a>`).join('')}</div>
      </section>`;
    }).join('')}</div>

    <section class="panel section" id="releases">
      <div class="panel-head"><h2>API release tracker</h2><span class="sub">${rows.length} models · prices in $ per 1M tokens</span>
        <a class="more" href="https://openrouter.ai/models?order=newest" target="_blank" rel="noopener">OpenRouter →</a></div>
      <div class="panel-body">
        <div class="toolbar">
          <input class="search" id="m-q" placeholder="Search models…" value="${esc(ui.q)}">
          <select id="m-prov"><option value="all">All providers</option>${providerIds.map((id) => `<option value="${id}" ${ui.provider === id ? 'selected' : ''}>${id}</option>`).join('')}</select>
          <select id="m-days">${[['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last year'], ['all', 'All']].map(([v, l]) => `<option value="${v}" ${ui.days === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <label class="check"><input type="checkbox" id="m-open" ${ui.open ? 'checked' : ''}> Open weights only</label>
        </div>
        <div class="table-wrap"><table>
          <thead><tr>${th('name', 'Model')}${th('provider', 'Provider')}${th('created', 'Released')}${th('context', 'Context', 'num')}${th('inPrice', 'Input $', 'num')}${th('outPrice', 'Output $', 'num')}</tr></thead>
          <tbody>${rows.slice(0, 300).map((m) => `<tr>
            <td><a href="https://openrouter.ai/${esc(m.id)}" target="_blank" rel="noopener"><b>${esc(m.name)}</b></a> ${m.openWeights ? `<a class="tag open" href="https://huggingface.co/${esc(m.hf)}" target="_blank" rel="noopener">open weights</a>` : ''}
              <div class="muted">${esc(m.modality || '')}</div></td>
            <td>${esc(provName(m))}</td><td style="white-space:nowrap">${new Date(m.created).toLocaleDateString()}</td>
            <td class="num">${ctx(m.context)}</td><td class="num">${price(m.inPrice)}</td><td class="num">${price(m.outPrice)}</td></tr>`).join('') || `<tr><td colspan="6">${empty('No models match.')}</td></tr>`}</tbody>
        </table></div>
      </div>
    </section>`;

  const rerender = () => { const pos = $('#m-q').selectionStart; render(); const i = $('#m-q'); i.focus(); i.setSelectionRange(pos, pos); };
  $('#m-q').oninput = (e) => { ui.q = e.target.value; rerender(); };
  $('#m-prov').onchange = (e) => { ui.provider = e.target.value; render(); };
  $('#m-days').onchange = (e) => { ui.days = e.target.value; render(); };
  $('#m-open').onchange = (e) => { ui.open = e.target.checked; render(); };
  document.querySelectorAll('th[data-sort]').forEach((t) => (t.onclick = () => {
    ui.dir = ui.sort === t.dataset.sort ? -ui.dir : t.dataset.sort === 'name' || t.dataset.sort === 'provider' ? 1 : -1;
    ui.sort = t.dataset.sort;
    render();
  }));
}

function renderNews() {
  const { data, config } = state;
  const ui = (state.ui.news ||= { cat: 'All', source: 'all', q: '', summaries: true });
  const q = ui.q.toLowerCase();
  const items = data.news.filter((n) => (ui.cat === 'All' || n.category === ui.cat) && (ui.source === 'all' || n.sourceId === ui.source)
    && (!q || (n.title + ' ' + n.summary).toLowerCase().includes(q)));
  const groups = [];
  for (const n of items) {
    const day = n.date ? new Date(n.date).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : 'Undated';
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1).items.push(n);
  }
  const cats = ['All', ...new Set(config.feeds.map((f) => f.category))];
  $('#app').innerHTML = `
    <div class="page-head"><div><h1>News</h1><p>Lab announcements, newsletters and tech press, merged into one timeline. ${data.news.length} stories from ${config.feeds.length} feeds.</p></div></div>
    <div class="toolbar">
      ${cats.map((c) => `<button class="chip ${ui.cat === c ? 'active' : ''}" data-cat="${c}">${c}</button>`).join('')}
      <select id="n-src"><option value="all">All sources</option>${config.feeds.filter((f) => ui.cat === 'All' || f.category === ui.cat).map((f) => `<option value="${f.id}" ${ui.source === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
      <input class="search" id="n-q" placeholder="Search headlines… e.g. Gemini, open weights, safety" value="${esc(ui.q)}">
      <label class="check"><input type="checkbox" id="n-sum" ${ui.summaries ? 'checked' : ''}> Summaries</label>
    </div>
    <div class="grid cols-3-2">
      <section class="panel"><div class="panel-body" style="padding-top:4px">${groups.length ? groups.map((g) =>
        `<div class="day-head">${esc(g.day)}</div><ul class="list">${g.items.map((n) => newsItem(n, { showSummary: ui.summaries })).join('')}</ul>`).join('') : empty('No stories match.')}</div></section>
      <aside class="stack" style="align-self:start">
        <section class="panel"><div class="panel-head"><h2>Sources</h2></div><div class="panel-body"><ul class="list">${config.feeds.map((f) => {
          const st = data.status?.[`feed:${f.id}`];
          const latest = data.news.find((n) => n.sourceId === f.id);
          return `<li class="item"><img src="${favicon(f.site)}" alt="" width="16" height="16" style="margin-top:3px" loading="lazy"><div class="main">
            <a class="title" href="${esc(f.site)}" target="_blank" rel="noopener">${esc(f.name)}</a>
            <div class="meta"><span class="tag">${esc(f.category)}</span><span>${latest ? 'latest ' + ago(latest.date) : 'no recent posts'}</span>${st && !st.ok ? '<span style="color:var(--bad)">feed error</span>' : ''}<a href="${esc(f.url)}" target="_blank" rel="noopener">RSS</a></div></div></li>`;
        }).join('')}</ul></div></section>
      </aside>
    </div>`;
  document.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { ui.cat = b.dataset.cat; ui.source = 'all'; render(); }));
  $('#n-src').onchange = (e) => { ui.source = e.target.value; render(); };
  $('#n-sum').onchange = (e) => { ui.summaries = e.target.checked; render(); };
  $('#n-q').oninput = (e) => { ui.q = e.target.value; const pos = e.target.selectionStart; render(); const i = $('#n-q'); i.focus(); i.setSelectionRange(pos, pos); };
}

function renderCommunity() {
  const { data, config } = state;
  const tab = (state.ui.ctab ||= ['hn', 'reddit', 'bluesky', 'papers', 'hfmodels', 'x'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'hn');
  const ui = (state.ui.comm ||= { hnSort: 'points', sub: 'all' });
  let body = '';
  if (tab === 'hn') {
    const items = [...data.hn].sort((a, b) => (ui.hnSort === 'date' ? ts(b.date) - ts(a.date) : b[ui.hnSort] - a[ui.hnSort]));
    body = `<div class="toolbar" style="margin:12px 0 0"><span class="sub" style="color:var(--faint)">AI stories from the past 7 days with 20+ points</span>
      <select id="hn-sort" style="margin-left:auto">${[['points', 'Most points'], ['comments', 'Most discussed'], ['date', 'Newest']].map(([v, l]) => `<option value="${v}" ${ui.hnSort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${list(items, hnItem, 60)}`;
  } else if (tab === 'reddit') {
    const subs = config.community.subreddits;
    const items = data.reddit.filter((r) => ui.sub === 'all' || r.sub.toLowerCase() === ui.sub.toLowerCase());
    body = `<div class="toolbar" style="margin:12px 0 0"><button class="chip ${ui.sub === 'all' ? 'active' : ''}" data-sub="all">All</button>${subs.map((s) => `<button class="chip ${ui.sub === s ? 'active' : ''}" data-sub="${s}">r/${s}</button>`).join('')}</div>
      ${list(items, redditItem, 75, `Reddit couldn't be reached from this network. Reddit sometimes blocks automated requests. Browse directly: ${subs.map((s) => `<a style="color:var(--accent)" href="https://www.reddit.com/r/${s}/top/?t=day" target="_blank" rel="noopener">r/${s}</a>`).join(' · ')}`)}`;
  } else if (tab === 'bluesky') {
    body = `<div class="note" style="margin:12px 0 0">Top AI posts on Bluesky from the last few days, ranked by likes and reposts. Bluesky's public API is open, so this updates live.</div>
      ${data.bluesky?.length ? `<div class="grid cols-2" style="gap:0 24px">${data.bluesky.map(bskyItem).join('')}</div>` : empty('No Bluesky posts available.')}`;
  } else if (tab === 'papers') {
    body = list(data.hf?.papers, paperItem, 30);
  } else if (tab === 'hfmodels') {
    body = list(data.hf?.models, hfModelItem, 30);
  } else {
    const recap = data.news.filter((n) => n.sourceId === 'ainews').slice(0, 5);
    const groups = [...new Set(config.xAccounts.map((a) => a.group))];
    body = `<div class="note" style="margin:12px 0">X/Twitter is where most model launches break, but its API isn't free to read, so posts can't be embedded automatically.
      Two workarounds: <b>AINews</b> recaps the day's top X discussion (latest issues below), and the accounts listed below are the ones worth following.
      Tip: build an <a href="https://x.com/i/lists/create" target="_blank" rel="noopener">X List</a> from them.</div>
      <h3 style="font-size:13px;color:var(--faint);text-transform:uppercase;letter-spacing:.05em">Daily X/Reddit/Discord recap</h3>
      ${list(recap, (n) => newsItem(n), 5, 'No recap available.')}
      ${groups.map((g) => `<div class="site-group"><h3>${esc(g)}</h3><div class="sites">${config.xAccounts.filter((a) => a.group === g).map((a) =>
        `<a class="site" href="https://x.com/${esc(a.handle)}" target="_blank" rel="noopener"><b>${esc(a.name)}</b><span>@${esc(a.handle)}</span></a>`).join('')}</div></div>`).join('')}`;
  }
  $('#app').innerHTML = `
    <div class="page-head"><div><h1>Community</h1><p>What people are sharing and discussing: Hacker News, Reddit, Bluesky, Hugging Face, and the voices to follow on X.</p></div></div>
    <section class="panel">
      ${tabs('ctab', [['hn', 'Hacker News', data.hn.length], ['reddit', 'Reddit', data.reddit.length], ['bluesky', 'Bluesky', data.bluesky?.length || 0],
        ['papers', 'HF papers', data.hf?.papers?.length || 0], ['hfmodels', 'HF trending', data.hf?.models?.length || 0], ['x', 'X / Twitter']], tab)}
      <div class="panel-body">${body}</div>
    </section>`;
  bindTabs();
  $('#hn-sort') && ($('#hn-sort').onchange = (e) => { ui.hnSort = e.target.value; render(); });
  document.querySelectorAll('[data-sub]').forEach((b) => (b.onclick = () => { ui.sub = b.dataset.sub; render(); }));
}

function renderResources() {
  const { config } = state;
  $('#app').innerHTML = `
    <div class="page-head"><div><h1>Go-to sites</h1><p>Bookmark-worthy places on the AI scene: leaderboards, newsletters, papers, communities and status pages.</p></div></div>
    ${config.sites.map((g) => `<div class="site-group"><h3>${esc(g.group)}</h3><div class="sites">${g.items.map((s) =>
      `<a class="site" href="${esc(s.url)}" target="_blank" rel="noopener"><b><img src="${favicon(s.url)}" alt="" loading="lazy">${esc(s.name)}</b><span>${esc(s.desc)}</span></a>`).join('')}</div></div>`).join('')}

    <section class="panel section" style="margin-top:24px">
      <div class="panel-head"><h2>Provider quick links</h2></div>
      <div class="panel-body table-wrap"><table><tbody>${config.providers.map((p) => `<tr>
        <td style="white-space:nowrap"><span class="dot" style="--pc:${p.color};margin-right:6px"></span><b>${esc(p.name)}</b></td>
        <td><div class="links">${Object.entries(p.links).map(([k, u]) => `<a class="chip" href="${esc(u)}" target="_blank" rel="noopener">${esc(k)}</a>`).join('')}
          <a class="chip" href="https://x.com/${esc(p.x)}" target="_blank" rel="noopener">X</a></div></td></tr>`).join('')}</tbody></table></div>
    </section>`;
}

function render() {
  if (!state.data) return;
  ({ overview: renderOverview, models: renderModels, news: renderNews, community: renderCommunity, resources: renderResources })[page]();
  updateStamp();
}

// ---------- boot ----------
renderShell();
$('#app').innerHTML = '<div class="skeleton" style="width:40%"></div><div class="skeleton"></div><div class="skeleton" style="width:80%"></div>';
const [config, snapshot] = await Promise.all([
  getJSON('config/sources.json'),
  getJSON('data/snapshot.json').catch(() => ({ generatedAt: null, news: [], models: [], hn: [], reddit: [], bluesky: [], hf: { models: [], papers: [] } })),
]);
state.config = config;
state.data = snapshot;
render();
const anchor = location.hash && page === 'models' && document.getElementById(location.hash.slice(1));
if (anchor) anchor.scrollIntoView();
refreshLive();
