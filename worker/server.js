/* JustSports news aggregator — plain Node, no dependencies, no Cloudflare.
 * Fetches real RSS feeds server-side (browsers can't, due to CORS), merges +
 * de-dupes, caches in memory for a minute. Run it on your own box.
 *
 *   node server.js            # listens on :8787 (override with PORT=...)
 *
 * Then point the frontend at it — set in ../app.js:
 *   const NEWS_WORKER = "http://YOUR-HOST:8787";
 *
 * Endpoint:  GET /news?sport=mlb|nba|f1  ->  { items: [...] }
 */
import { createServer } from "node:http";
import { FEEDS, getNews, CACHE_SECONDS } from "./feeds.js";

const PORT = Number(process.env.PORT) || 8787;
const cache = new Map(); // sport -> { ts, body }

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") return send(res, 200, { ok: true });
  if (url.pathname !== "/news") return send(res, 404, { error: "Use /news?sport=mlb|nba|f1" });

  const sport = (url.searchParams.get("sport") || "").toLowerCase();
  if (!FEEDS[sport]) return send(res, 400, { error: "Unknown sport" });

  const now = Date.now();
  const hit = cache.get(sport);
  if (hit && now - hit.ts < CACHE_SECONDS * 1000) return sendRaw(res, 200, hit.body);

  try {
    const items = await getNews(sport);
    const body = JSON.stringify({ items });
    cache.set(sport, { ts: now, body });
    sendRaw(res, 200, body);
  } catch {
    // Serve a stale copy if we have one, otherwise report upstream failure.
    if (hit) return sendRaw(res, 200, hit.body);
    send(res, 502, { error: "Upstream feeds unavailable" });
  }
});

function send(res, status, obj) { sendRaw(res, status, JSON.stringify(obj)); }
function sendRaw(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
  });
  res.end(body);
}

server.listen(PORT, () => console.log(`JustSports news aggregator on http://0.0.0.0:${PORT}`));
