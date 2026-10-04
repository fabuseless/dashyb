# AI Pulse: AI model news dashboard

A static dashboard that tracks the AI model scene:

- **Overview** (`index.html`): the current flagship from 12 labs, today's headlines, community buzz, fresh API releases, trending papers and models, and go-to sites.
- **Models** (`models.html`): a detail card for each provider (flagship, family, official links, latest API releases) plus a searchable, sortable release tracker with context size and prices.
- **News** (`news.html`): 17 lab, newsletter and press feeds merged into one timeline, with filters and search.
- **Community** (`community.html`): Hacker News, Reddit, Bluesky, Hugging Face papers and trending models, plus an X/Twitter directory and daily recap.
- **Go-to sites** (`resources.html`): leaderboards, newsletters, papers, communities, status pages, and quick links for each provider.

## How data flows

| Source | How |
|---|---|
| Lab blogs, newsletters, press (RSS) | `scripts/update-data.mjs` → `data/snapshot.json` (browsers can't read most feeds directly because of CORS) |
| OpenRouter models, Hacker News, Hugging Face, Bluesky, Reddit | In the snapshot **and** refreshed live in the browser when the snapshot is over an hour old (↻ forces it) |
| X/Twitter | No free read API, so the dashboard links the AINews daily recap of X discussion plus a curated list of accounts |

The GitHub Action in `.github/workflows/update.yml` rebuilds the snapshot every 3 hours, commits it, and deploys the site to GitHub Pages.

## Setup

1. **Enable Pages:** go to repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Run the **Update data & deploy** workflow once (Actions tab → Run workflow), or wait for the schedule.

Local:

```sh
node scripts/update-data.mjs   # Node 20+, no dependencies
python3 -m http.server 8080    # then open http://localhost:8080
```

## Keeping it current

Everything is in `config/sources.json`:

- `providers[].headline` is the hand-picked flagship for each lab. When OpenRouter lists a newer model from that lab, the card shows a green **"New on API"** badge, which is your cue to update the headline.
- Add or remove feeds, subreddits, Bluesky handles, X accounts and sites there too.
