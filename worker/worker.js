/* JustSports — optional Cloudflare Worker (alternative to server.js).
 * Same aggregation as the Node server, using Cloudflare's edge cache.
 *
 * Deploy:  npx wrangler deploy
 * Then set NEWS_WORKER in ../app.js to the printed workers.dev URL.
 *
 * Endpoint:  GET /news?sport=mlb|nba|f1  ->  { items: [...] }
 */
import { FEEDS, getNews, CACHE_SECONDS } from "./feeds.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (url.pathname !== "/news") return json({ error: "Use /news?sport=mlb|nba|f1" }, 404);

    const sport = (url.searchParams.get("sport") || "").toLowerCase();
    if (!FEEDS[sport]) return json({ error: "Unknown sport" }, 400);

    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;

    const items = await getNews(sport);
    const res = json({ items });
    res.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
    await cache.put(request, res.clone());
    return res;
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}
