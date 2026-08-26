# JustSports

Just a sports app for self-hosting. Scores, standings, and news for MLB, NBA, and F1 — no betting odds, no images, no video.

Vanilla HTML/CSS/JS. No build step, no dependencies, no API keys.

## Run

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000

## Data

MLB/NBA from ESPN's public JSON; F1 from Jolpica (Ergast). News is ESPN's feed by default.

## Multi-source news (optional)

For merged headlines from many outlets (ESPN, CBS, BBC, Sky, MLB.com, ...) instead of ESPN-only, run the little aggregator in `worker/` — it fetches the RSS feeds server-side (browsers can't, due to CORS), de-dupes, and caps each outlet so none dominates.

```bash
cd worker
node server.js          # http://localhost:8787
```

Then set `NEWS_WORKER` near the top of `app.js` to that URL. There's a `worker/Dockerfile` to run it as a container, and a Cloudflare-Worker variant (`worker/worker.js`) if you'd rather deploy it than host it. Edit the feed list in `worker/feeds.js`.