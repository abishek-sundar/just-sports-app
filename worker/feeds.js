/* Shared news-aggregation logic for JustSports.
 * Used by both the Node server (server.js) and the Cloudflare Worker (worker.js).
 * Pure fetch/parse/merge — no runtime-specific APIs, so it runs in either.
 */

export const FEEDS = {
  mlb: [
    "https://www.espn.com/espn/rss/mlb/news",
    "https://www.mlbtraderumors.com/feed",
    "https://www.mlb.com/feeds/news/rss.xml",
    "https://www.cbssports.com/rss/headlines/mlb/",
  ],
  nba: [
    "https://www.espn.com/espn/rss/nba/news",
    "https://www.nba.com/rss/nba_rss.xml",
    "https://www.cbssports.com/rss/headlines/nba/",
    "https://feeds.bbci.co.uk/sport/basketball/rss.xml",
  ],
  f1: [
    "https://www.espn.com/espn/rss/rpm/news", // ESPN racing
    "https://www.motorsport.com/rss/f1/news/",
    "https://www.autosport.com/rss/f1/news/",
    "https://feeds.bbci.co.uk/sport/formula1/rss.xml",
    "https://www.skysports.com/rss/12433", // Sky Sports F1
  ],
};

export const CACHE_SECONDS = 60;
const MAX_ITEMS = 20;      // headlines returned per sport
const PER_SOURCE_CAP = 5;  // max from any single outlet, so no feed dominates

// Fetch every feed for a sport, merge, de-dupe, newest first, cap at 20.
export async function getNews(sport) {
  const feeds = FEEDS[sport];
  if (!feeds) return [];
  const results = await Promise.allSettled(feeds.map((f) => fetchFeed(f)));
  const items = [];
  for (const r of results) if (r.status === "fulfilled") items.push(...r.value);

  // Newest first, then de-dupe so the freshest copy of a repeated story wins.
  // Keyed on a normalized title (case/punctuation-insensitive) and on the link,
  // which catches identical/syndicated headlines shared across outlets.
  const seen = new Set();
  const deduped = items
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .filter((it) => {
      const titleKey = normalizeTitle(it.headline);
      const linkKey = (it.href || "").split("?")[0].toLowerCase();
      if (!titleKey) return false;
      if (seen.has(titleKey) || (linkKey && seen.has(linkKey))) return false;
      seen.add(titleKey);
      if (linkKey) seen.add(linkKey);
      return true;
    });

  // Cap each outlet so one high-volume feed can't crowd out the rest; stays
  // newest-first overall, just diversified across sources.
  const counts = {};
  const merged = [];
  for (const it of deduped) {
    const n = counts[it.source] || 0;
    if (n >= PER_SOURCE_CAP) continue;
    counts[it.source] = n + 1;
    merged.push(it);
    if (merged.length >= MAX_ITEMS) break;
  }
  return merged.map(({ ts, ...rest }) => rest);
}

async function fetchFeed(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: {
      "User-Agent": "JustSports/1.0 (+rss)",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
  });
  if (!res.ok) throw new Error(`${feedUrl} -> ${res.status}`);
  const xml = await res.text();
  const source = new URL(feedUrl).hostname.replace(/^www\./, "");
  return parseRss(xml, source);
}

/* Minimal RSS/Atom parser — regex-based, dependency-free, good enough for text. */
function parseRss(xml, source) {
  const items = [];
  const blocks = matchAll(xml, /<(item|entry)\b[\s\S]*?<\/\1>/gi);
  for (const block of blocks) {
    const headline = clean(tag(block, "title"));
    if (!headline) continue;
    const desc = clean(tag(block, "description") || tag(block, "summary")).slice(0, 240);
    const href = linkHref(block);
    const dateStr = tag(block, "pubDate") || tag(block, "published") || tag(block, "updated") || "";
    const ts = parseDate(dateStr);
    items.push({
      headline,
      desc,
      href,
      published: dateStr ? new Date(ts || Date.now()).toISOString() : null,
      source,
      ts,
    });
  }
  return items;
}

// Date.parse chokes on named timezones some feeds use (e.g. Sky's "... BST").
// Retry with the abbreviation swapped for a numeric offset.
const TZ_OFFSETS = {
  GMT: "+0000", UTC: "+0000", BST: "+0100",
  EST: "-0500", EDT: "-0400", CST: "-0600", CDT: "-0500",
  MST: "-0700", MDT: "-0600", PST: "-0800", PDT: "-0700",
};
function parseDate(str) {
  if (!str) return 0;
  let t = Date.parse(str);
  if (!Number.isNaN(t)) return t;
  const m = str.trim().match(/\b([A-Z]{2,4})$/);
  if (m && TZ_OFFSETS[m[1]]) {
    t = Date.parse(str.replace(/\b[A-Z]{2,4}$/, TZ_OFFSETS[m[1]]));
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

// Lowercase, drop punctuation, collapse whitespace — so "Norris wins!" and
// "norris wins" (or the same wire story carried by two outlets) hash together.
function normalizeTitle(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m ? m[1] : "";
}
function linkHref(block) {
  // RSS: <link>URL</link>. Atom: <link href="URL" .../>.
  const rss = block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
  if (rss && rss[1].trim()) return clean(rss[1]);
  const atom = block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
  return atom ? atom[1] : null;
}
function clean(s) {
  if (!s) return "";
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ")
    .trim();
}
function matchAll(str, re) {
  const out = [];
  let m;
  while ((m = re.exec(str)) !== null) out.push(m[0]);
  return out;
}
