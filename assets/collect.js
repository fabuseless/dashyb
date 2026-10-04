// Source collectors shared by the browser (live refresh) and scripts/update-data.mjs (scheduled snapshot).
// Each collector takes the parsed config and a `get(url, {json})` function and returns normalized items.

const DAY = 86400e3;

// ---------- RSS / Atom ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e.toLowerCase()] ?? m);
const unCdata = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
// Feeds often entity-encode their HTML, so decode before and after stripping tags.
const text = (s) => decode(decode(unCdata(s || '')).replace(/<[^>]+>/g, ' ')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
};
const clip = (s, n) => (s.length > n ? s.slice(0, n - 3).replace(/\s+\S*$/, '') + '…' : s);

export function parseFeed(xml) {
  const items = [];
  for (const b of xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || []) {
    let link = text(tag(b, 'link'));
    if (!link) {
      const alt = b.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)/i) || b.match(/<link\b[^>]*href=["']([^"']+)/i);
      link = alt ? decode(alt[1]) : text(tag(b, 'guid'));
    }
    const dateStr = text(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const date = dateStr ? new Date(dateStr) : null;
    items.push({
      title: text(tag(b, 'title')),
      link,
      date: date && !isNaN(date) ? date.toISOString() : null,
      summary: clip(text(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content') || tag(b, 'content:encoded')), 320),
    });
  }
  return items;
}

export async function collectFeed(feed, get, { maxAgeDays = 45, perFeed = 25 } = {}) {
  const cutoff = Date.now() - maxAgeDays * DAY;
  return parseFeed(await get(feed.url))
    .filter((i) => i.title && i.link)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    // Always keep a feed's newest few posts so quieter labs still show up.
    .filter((i, idx) => idx < 4 || !i.date || Date.parse(i.date) > cutoff)
    .slice(0, perFeed)
    .map((i) => ({ ...i, source: feed.name, sourceId: feed.id, category: feed.category }));
}

// ---------- Models (OpenRouter) ----------
export async function collectModels(config, get) {
  const { data } = await get('https://openrouter.ai/api/v1/models', { json: true });
  const cutoff = Date.now() / 1000 - 540 * 86400;
  return data
    .filter((m) => !m.id.includes(':') && !m.id.startsWith('~') && m.created > cutoff)
    .map((m) => ({
      id: m.id,
      name: m.name.replace(/^[^:]+:\s*/, ''),
      provider: m.id.split('/')[0],
      created: new Date(m.created * 1000).toISOString(),
      context: m.context_length,
      inPrice: +m.pricing?.prompt * 1e6 || 0,
      outPrice: +m.pricing?.completion * 1e6 || 0,
      modality: m.architecture?.modality,
      openWeights: !!m.hugging_face_id,
      hf: m.hugging_face_id || null,
      description: clip((m.description || '').replace(/\s+/g, ' '), 400),
    }))
    .sort((a, b) => b.created.localeCompare(a.created));
}

// Loose relevance check used to drop off-topic posts from keyword searches and author feeds.
const AI_TERMS = /\b(AI|AGI|ML|LLMs?|chatbots?|Codex|Copilot|Cursor|Hugging ?Face|neural|transformers?|diffusion|GPT|Claude|Gemini|Grok|OpenAI|Anthropic|DeepMind|DeepSeek|Qwen|Kimi|Mistral|Llama|Muse|models?|agents?|benchmarks?|open[- ]weights?|reasoning|Astra|Opus|Sonnet|Haiku|Fable|Mythos|GLM|MiniMax|Nemotron|Phi|Ollama|llama\.cpp|vLLM|fine-?tun\w*|training|inference|tokens?|weights)\b/i;

// ---------- Hacker News ----------
export async function collectHN(config, get, queries = config.community.hnQueries) {
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const lists = await Promise.all(
    queries.map(async (q) => {
      const p = new URLSearchParams({ query: q, tags: 'story', numericFilters: `created_at_i>${since},points>20`, hitsPerPage: '30' });
      return (await get(`https://hn.algolia.com/api/v1/search?${p}`, { json: true })).hits;
    })
  );
  const byId = new Map();
  for (const h of lists.flat()) byId.set(h.objectID, h);
  return [...byId.values()]
    .filter((h) => AI_TERMS.test(h.title))
    .map((h) => ({
      title: h.title,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
      points: h.points,
      comments: h.num_comments || 0,
      author: h.author,
      date: h.created_at,
    }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 60);
}

// ---------- Reddit ----------
export async function collectReddit(config, get) {
  const lists = await Promise.all(
    config.community.subreddits.map(async (sub) => {
      const j = await get(`https://www.reddit.com/r/${sub}/top.json?t=day&limit=15&raw_json=1`, { json: true });
      return j.data.children.map(({ data: d }) => ({
        title: decode(d.title),
        url: d.is_self ? `https://www.reddit.com${d.permalink}` : d.url,
        discussion: `https://www.reddit.com${d.permalink}`,
        score: d.score,
        comments: d.num_comments,
        sub: d.subreddit,
        flair: d.link_flair_text || null,
        date: new Date(d.created_utc * 1000).toISOString(),
      }));
    })
  );
  return lists.flat().sort((a, b) => b.score - a.score);
}

// ---------- Bluesky ----------

const bskyPost = (p) => ({
  text: p.record?.text || '',
  author: p.author.displayName || p.author.handle,
  handle: p.author.handle,
  avatar: p.author.avatar || null,
  url: `https://bsky.app/profile/${p.author.handle}/post/${p.uri.split('/').pop()}`,
  likes: p.likeCount || 0,
  reposts: p.repostCount || 0,
  replies: p.replyCount || 0,
  date: p.record?.createdAt || p.indexedAt,
});

export async function collectBluesky(config, get) {
  const api = 'https://public.api.bsky.app/xrpc';
  let posts = [];
  try {
    const p = new URLSearchParams({ q: config.community.blueskyQuery, sort: 'top', limit: '50', since: new Date(Date.now() - 3 * DAY).toISOString() });
    posts = (await get(`${api}/app.bsky.feed.searchPosts?${p}`, { json: true })).posts.map(bskyPost);
  } catch {
    // Search is sometimes closed to anonymous clients; fall back to curated author feeds below.
  }
  if (posts.length < 10) {
    const feeds = await Promise.allSettled(
      config.community.blueskyHandles.map((h) => get(`${api}/app.bsky.feed.getAuthorFeed?actor=${h}&limit=30&filter=posts_no_replies`, { json: true }))
    );
    for (const f of feeds) if (f.status === 'fulfilled') posts.push(...f.value.feed.filter((x) => !x.reason).map((x) => bskyPost(x.post)));
    posts = posts.filter((p) => Date.parse(p.date) > Date.now() - 7 * DAY && AI_TERMS.test(p.text));
  }
  if (!posts.length) throw new Error('no posts returned');
  return posts.sort((a, b) => b.likes + 2 * b.reposts - (a.likes + 2 * a.reposts)).slice(0, 50);
}

// ---------- Hugging Face ----------
export async function collectHF(config, get) {
  const [models, papers] = await Promise.all([
    get('https://huggingface.co/api/models?sort=trendingScore&limit=30', { json: true }),
    get('https://huggingface.co/api/daily_papers?limit=30', { json: true }),
  ]);
  return {
    models: models.map((m) => ({
      id: m.id,
      url: `https://huggingface.co/${m.id}`,
      likes: m.likes,
      downloads: m.downloads,
      trending: m.trendingScore,
      task: m.pipeline_tag || null,
      created: m.createdAt,
    })),
    papers: papers
      .map((p) => ({
        title: p.title || p.paper?.title,
        url: `https://huggingface.co/papers/${p.paper?.id}`,
        upvotes: p.paper?.upvotes || 0,
        summary: clip((p.paper?.ai_summary || p.paper?.summary || '').replace(/\s+/g, ' '), 300),
        date: p.publishedAt,
      }))
      .sort((a, b) => b.upvotes - a.upvotes),
  };
}
