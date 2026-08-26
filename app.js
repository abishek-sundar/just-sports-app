/* JustSports — vanilla, keyless, text-only.
 * Scores/standings/news: ESPN site API (NBA/MLB) + Jolpica/Ergast (F1).
 * Optional real-RSS + caching via a Cloudflare Worker (see worker/). No build step.
 */

/* ---------- Config ---------- */
// News source.
//   ""   → ESPN's keyless JSON only (zero setup, every headline from ESPN).
//   "/"  → same-origin "/news" (the aggregator in worker/, proxied by nginx) for
//          merged multi-source RSS (ESPN, CBS, BBC, Sky, MLB.com, ...).
//   full URL (e.g. "http://host:8787") → aggregator on another origin.
// If the aggregator is unreachable, the app automatically falls back to ESPN.
const NEWS_WORKER = "/";

// `window` is the results range in days around today: how many days back (past)
// and ahead (future) to pull. Today is always included and shown first.
const SPORTS = [
  { key: "mlb", label: "MLB", kind: "ball", espn: "baseball/mlb",    window: { past: 2, future: 7 } },
  { key: "nba", label: "NBA", kind: "ball", espn: "basketball/nba",  window: { past: 2, future: 7 } },
  { key: "f1",  label: "F1",  kind: "f1",   espnNews: "racing/f1" },
];

// F1 constructor colors (Jolpica doesn't supply them). Extend as the grid changes.
const F1_COLORS = {
  mclaren: "#ff8000", ferrari: "#e8002d", red_bull: "#3671c6", mercedes: "#27f4d2",
  aston_martin: "#229971", alpine: "#0093cc", williams: "#64c4ff", rb: "#6692ff",
  sauber: "#52e252", audi: "#52e252", haas: "#b6babd", cadillac: "#b6862c",
};

const POLL_MS = 60_000;
const DEFAULT_WINDOW = { past: 3, future: 0 }; // fallback if a sport omits `window`

let activeSport = SPORTS[0].key;
let activeView = "results"; // results | standings
let pollTimer = null;

const $ = (sel) => document.querySelector(sel);
const scoresEl = () => $("#scores");
const newsEl = () => $("#news");

/* ---------- Theme ---------- */
function initTheme() {
  const saved = localStorage.getItem("js-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
  $("#theme-toggle").addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    localStorage.setItem("js-theme", next);
    applyTheme(next);
    rerenderScores(); // recolor teams for the new background
  });
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $(".theme-toggle-label").textContent = theme === "dark" ? "Light" : "Dark";
}
const isDark = () => document.documentElement.getAttribute("data-theme") === "dark";

/* ---------- Color helpers ---------- */
function hexToRgb(hex) {
  if (!hex) return null;
  const h = hex.replace("#", "").trim();
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function luminance({ r, g, b }) {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
const mix = (c, t, amt) => ({
  r: Math.round(c.r + (t.r - c.r) * amt),
  g: Math.round(c.g + (t.g - c.g) * amt),
  b: Math.round(c.b + (t.b - c.b) * amt),
});
const rgbStr = ({ r, g, b }) => `rgb(${r}, ${g}, ${b})`;

// Keep a team color legible against the current theme's surface.
function readableTeamColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const lum = luminance(rgb);
  // Only rescue the extremes so colors stay vibrant; near-black/white bgs give headroom.
  if (isDark()) return lum < 0.11 ? rgbStr(mix(rgb, { r: 255, g: 255, b: 255 }, 0.5)) : rgbStr(rgb);
  return lum > 0.72 ? rgbStr(mix(rgb, { r: 0, g: 0, b: 0 }, 0.32)) : rgbStr(rgb);
}

/* ---------- Fetch ---------- */
async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}
function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
function dateRange({ past, future }) {
  const start = new Date();
  start.setDate(start.getDate() - past);
  const end = new Date();
  end.setDate(end.getDate() + future);
  return `${ymd(start)}-${ymd(end)}`;
}

async function fetchBallScores(sport) {
  const win = sport.window || DEFAULT_WINDOW;
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport.espn}/scoreboard?dates=${dateRange(win)}&limit=400`;
  const data = await getJSON(url);
  const games = (data.events || []).map((ev) => {
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const cs = comp.competitors || [];
    const pick = (side) => {
      const c = cs.find((x) => x.homeAway === side) || {};
      const t = c.team || {};
      return {
        name: t.shortDisplayName || t.displayName || t.abbreviation || "—",
        score: c.score,
        color: t.color ? `#${t.color}` : null,
        winner: !!c.winner,
      };
    };
    const st = (ev.status && ev.status.type) || {};
    return {
      home: pick("home"),
      away: pick("away"),
      state: st.state || "pre",
      detail: st.shortDetail || st.detail || "",
      date: ev.date,
    };
  });
  // Live first, then upcoming, then finals — newest finals first.
  const rank = { in: 0, pre: 1, post: 2 };
  games.sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    const ta = new Date(a.date).getTime(), tb = new Date(b.date).getTime();
    return a.state === "post" ? tb - ta : ta - tb;
  });
  return games;
}

// Season schedule: the next race (with session times) + every race run so far
// (most recent first). Results load on demand.
function raceStart(r) {
  return new Date(`${r.date}T${r.time || "12:00:00Z"}`);
}
// Build the next-race card: all weekend sessions in chronological order.
function buildNextRace(r) {
  const S = (obj, label) => (obj ? { label, date: obj.date, time: obj.time } : null);
  const sessions = [
    S(r.FirstPractice, "FP1"),
    S(r.SecondPractice, "FP2"),
    S(r.ThirdPractice, "FP3"),
    S(r.SprintQualifying, "Sprint Quali"),
    S(r.Sprint, "Sprint"),
    S(r.Qualifying, "Qualifying"),
    S({ date: r.date, time: r.time }, "Race"),
  ].filter(Boolean);
  const iso = (s) => `${s.date}T${s.time || "12:00:00Z"}`;
  sessions.sort((a, b) => new Date(iso(a)) - new Date(iso(b)));
  return {
    round: r.round,
    name: r.raceName,
    country: r.Circuit?.Location?.country || "",
    date: r.date,
    sessions,
  };
}
async function fetchF1Schedule() {
  const data = await getJSON("https://api.jolpi.ca/ergast/f1/current/races/?format=json");
  const races = data?.MRData?.RaceTable?.Races || [];
  const now = new Date();
  const past = races
    .filter((r) => raceStart(r) <= now)
    .map((r) => ({
      round: r.round,
      name: r.raceName,
      date: r.date,
      country: r.Circuit?.Location?.country || "",
    }))
    .sort((a, b) => Number(b.round) - Number(a.round));
  // Upcoming races (soonest first). The first gets a full session breakdown;
  // the rest are listed compactly on the Schedule tab.
  const future = races.filter((r) => raceStart(r) > now)
    .sort((a, b) => Number(a.round) - Number(b.round));
  // Every upcoming race carries its full session breakdown (FP1…Race).
  const upcoming = future.map(buildNextRace);
  const next = upcoming[0] || null;
  return { next, upcoming, past };
}

const _f1Rounds = {}; // round -> { results[], hasSprint }
async function fetchF1RoundResults(round) {
  if (_f1Rounds[round]) return _f1Rounds[round];
  // A weekend's points = race points + any sprint points, summed per driver.
  const [raceData, sprintData] = await Promise.all([
    getJSON(`https://api.jolpi.ca/ergast/f1/current/${round}/results/?format=json`),
    getJSON(`https://api.jolpi.ca/ergast/f1/current/${round}/sprint/?format=json`).catch(() => null),
  ]);
  const race = raceData?.MRData?.RaceTable?.Races?.[0];
  const sprint = sprintData?.MRData?.RaceTable?.Races?.[0]?.SprintResults || [];
  const sprintPts = {};
  for (const s of sprint) sprintPts[s.Driver.driverId] = Number(s.points) || 0;
  const results = (race?.Results || []).slice(0, 10).map((r) => ({
    pos: r.position,
    driver: `${r.Driver.givenName} ${r.Driver.familyName}`,
    constructor: r.Constructor.name,
    color: F1_COLORS[r.Constructor.constructorId] || null,
    time: r.Time?.time || r.status || "",
    points: (Number(r.points) || 0) + (sprintPts[r.Driver.driverId] || 0),
  }));
  _f1Rounds[round] = { results, hasSprint: sprint.length > 0 };
  return _f1Rounds[round];
}

/* ---- Standings ---- */
function statMap(entry) {
  const m = {};
  for (const s of entry.stats || []) {
    if (s.name) m[s.name] = s.displayValue;
    if (s.type) m[s.type] = s.displayValue;
    if (s.abbreviation) m[s.abbreviation] = s.displayValue;
  }
  return m;
}
// ESPN standings omits team colors, so pull them from the teams endpoint (cached).
const _teamColors = {};
async function teamColorMap(sport) {
  if (_teamColors[sport.key]) return _teamColors[sport.key];
  const map = {};
  try {
    const data = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/${sport.espn}/teams`);
    const teams = data?.sports?.[0]?.leagues?.[0]?.teams || [];
    for (const w of teams) {
      const t = w.team || {};
      if (t.abbreviation && t.color) map[t.abbreviation] = `#${t.color}`;
    }
  } catch { /* colors are optional */ }
  _teamColors[sport.key] = map;
  return map;
}

async function fetchBallStandings(sport) {
  const [data, colors] = await Promise.all([
    getJSON(`https://site.api.espn.com/apis/v2/sports/${sport.espn}/standings`),
    teamColorMap(sport),
  ]);
  const groups = (data.children || []).map((child) => {
    const entries = (child.standings?.entries || []).map((e) => {
      const s = statMap(e);
      const t = e.team || {};
      return {
        name: t.shortDisplayName || t.displayName || t.abbreviation || "—",
        color: (t.color ? `#${t.color}` : null) || colors[t.abbreviation] || null,
        wins: s.wins ?? s.W ?? "",
        losses: s.losses ?? s.L ?? "",
        pct: s.winPercent ?? s.leagueWinPercent ?? s.PCT ?? "",
        gb: s.gamesBehind ?? s.GB ?? "",
      };
    });
    return { title: child.name || child.abbreviation || "", entries };
  });
  return groups.filter((g) => g.entries.length);
}
async function fetchF1Standings() {
  const [dData, cData] = await Promise.all([
    getJSON("https://api.jolpi.ca/ergast/f1/current/driverStandings/?format=json"),
    getJSON("https://api.jolpi.ca/ergast/f1/current/constructorStandings/?format=json").catch(() => null),
  ]);
  const groups = [];
  const dList = dData?.MRData?.StandingsTable?.StandingsLists?.[0];
  if (dList) {
    const entries = (dList.DriverStandings || []).map((d) => {
      const con = d.Constructors?.[d.Constructors.length - 1] || {};
      return {
        name: `${d.Driver.givenName} ${d.Driver.familyName}`,
        sub: con.name || "",
        color: F1_COLORS[con.constructorId] || null,
        points: d.points,
        wins: d.wins,
      };
    });
    groups.push({ title: `Drivers · ${dList.season}`, entries, f1: true });
  }
  const cList = cData?.MRData?.StandingsTable?.StandingsLists?.[0];
  if (cList) {
    const entries = (cList.ConstructorStandings || []).map((c) => ({
      name: c.Constructor.name,
      color: F1_COLORS[c.Constructor.constructorId] || null,
      points: c.points,
      wins: c.wins,
    }));
    groups.push({ title: "Constructors", entries, f1: true });
  }
  return groups;
}

async function fetchNews(sport) {
  if (NEWS_WORKER) {
    try {
      const data = await getJSON(`${NEWS_WORKER.replace(/\/$/, "")}/news?sport=${sport.key}`);
      const items = (data.items || []).slice(0, 14);
      if (items.length) return items;
    } catch { /* aggregator down — fall back to ESPN below */ }
  }
  const path = sport.espnNews || sport.espn;
  const data = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/${path}/news`);
  return (data.articles || []).slice(0, 12).map((a) => ({
    headline: a.headline,
    desc: a.description,
    href: a.links?.web?.href || a.links?.mobile?.href || null,
    published: a.published,
    source: "espn.com",
  }));
}

// Pretty label for a feed's hostname (worker sends the source host).
function sourceLabel(src) {
  if (!src) return "";
  const s = src.toLowerCase();
  const map = [
    ["espn", "ESPN"], ["mlbtraderumors", "MLB Trade Rumors"], ["mlb.com", "MLB.com"],
    ["cbssports", "CBS Sports"], ["nba.com", "NBA.com"], ["bbc", "BBC Sport"],
    ["skysports", "Sky Sports"], ["motorsport", "Motorsport.com"], ["autosport", "Autosport"],
  ];
  for (const [needle, label] of map) if (s.includes(needle)) return label;
  return src.replace(/^www\./, "");
}

/* ---------- Render helpers ---------- */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function skeletons(container, n = 3) {
  container.replaceChildren(...Array.from({ length: n }, () => el("div", "skeleton")));
}
// Date-only strings (F1 "2026-08-23") parse as UTC and can roll back a day in
// western timezones — anchor them at local noon. Full timestamps pass through.
const toDate = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + "T12:00:00") : new Date(iso));
const fmtTime = (iso) => (iso ? toDate(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
const fmtDate = (iso) => (iso ? toDate(iso).toLocaleDateString([], { month: "short", day: "numeric" }) : "");
const stripTime = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayKey = (iso) => { const d = toDate(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
// Whole-day offset from today: 0 today, +1 tomorrow, -1 yesterday, etc.
const dayDiff = (iso) => Math.round((stripTime(toDate(iso)) - stripTime(new Date())) / 86400000);
function dayLabel(iso) {
  const diff = dayDiff(iso);
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  if (diff === 1) return "Tomorrow";
  return toDate(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/* ---------- Render: results ---------- */
function teamRow(t, showScore) {
  const row = el("div", "game-row");
  const name = el("span", "team-name", t.name);
  const color = readableTeamColor(t.color);
  if (color) name.style.setProperty("--team", color);
  if (showScore && !t.winner) name.classList.add("loser");
  row.appendChild(name);
  if (showScore) row.appendChild(el("span", "score", t.score ?? "–"));
  return row;
}
function gameCard(g) {
  const showScore = g.state !== "pre";
  const card = el("div", "game");

  if (!showScore) {
    // Upcoming game — no scores yet, so use the empty right side for a big start time.
    card.classList.add("upcoming");
    const accent = readableTeamColor(g.away.color);
    if (accent) card.style.setProperty("--team", accent);
    const teams = el("div", "game-teams");
    for (const t of [g.away, g.home]) {
      const name = el("div", "team-name", t.name);
      const c = readableTeamColor(t.color);
      if (c) name.style.setProperty("--team", c);
      teams.appendChild(name);
    }
    const when = el("div", "game-when");
    if (g.date) {
      when.appendChild(el("span", "when-time", fmtTime(g.date)));
      when.appendChild(el("span", "when-date", fmtDate(g.date)));
    } else {
      when.appendChild(el("span", "when-time", "TBD"));
    }
    card.append(teams, when);
    return card;
  }

  const lead = showScore ? (Number(g.home.score) >= Number(g.away.score) ? g.home : g.away) : g.away;
  const accent = readableTeamColor(lead.color);
  if (accent) card.style.setProperty("--team", accent);
  card.appendChild(teamRow(g.away, showScore));
  card.appendChild(teamRow(g.home, showScore));
  const meta = el("div", "game-meta");
  if (g.state === "in") meta.appendChild(el("span", "live-dot", "● LIVE"));
  else if (g.state === "post") meta.appendChild(el("span", "final-tag", "FINAL"));
  meta.appendChild(el("span", null, `${fmtDate(g.date)} · ${fmtTime(g.date)}`));
  // Live clock/inning detail (Final is already shown as its own tag).
  if (g.state === "in" && g.detail) {
    meta.appendChild(el("span", "dot", "·"));
    meta.appendChild(el("span", null, g.detail));
  }
  card.appendChild(meta);
  return card;
}

// Day ordering: Today first, then upcoming days nearest-first, then past days
// most-recent-first. (For a past-only window this is just most-recent-first.)
function dayOrderKey(iso) {
  const diff = dayDiff(iso);
  if (diff === 0) return [0, 0];
  return diff > 0 ? [1, diff] : [2, -diff];
}
function renderDayGroups(games, emptyMsg) {
  const c = scoresEl();
  if (!games || !games.length) { c.replaceChildren(el("p", "empty", emptyMsg)); return; }
  // Group by calendar day.
  const byDay = new Map();
  for (const g of games) {
    const k = dayKey(g.date);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(g);
  }
  const days = [...byDay.entries()].sort((a, b) => {
    const [ga, sa] = dayOrderKey(a[1][0].date);
    const [gb, sb] = dayOrderKey(b[1][0].date);
    return ga - gb || sa - sb;
  });

  const frag = document.createDocumentFragment();
  for (const [, dayGames] of days) {
    // Within a day, by game time: live now, then upcoming (soonest next first),
    // then finished games (most-recently-done first) at the end.
    const rank = { in: 0, pre: 1, post: 2 };
    dayGames.sort((a, b) => {
      if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
      const ta = new Date(a.date), tb = new Date(b.date);
      return a.state === "post" ? tb - ta : ta - tb;
    });
    const isToday = dayDiff(dayGames[0].date) === 0;
    const group = el("div", isToday ? "day-group today" : "day-group");
    group.appendChild(el("div", "day-header", dayLabel(dayGames[0].date)));
    const gamesWrap = el("div", "day-games");
    for (const g of dayGames) gamesWrap.appendChild(gameCard(g));
    group.appendChild(gamesWrap);
    frag.appendChild(group);
  }
  c.replaceChildren(frag);
}
// Results = everything today (live, final, and not-yet-started) plus past days.
function renderResults(games) {
  renderDayGroups((games || []).filter((g) => dayDiff(g.date) <= 0),
    "No games today or recently.");
}
// Schedule = upcoming games from tomorrow onward.
function renderSchedule(games) {
  renderDayGroups((games || []).filter((g) => dayDiff(g.date) >= 1),
    "No upcoming games scheduled.");
}
function f1ResultRows(container, data) {
  container.replaceChildren();
  const results = data?.results;
  if (!results || !results.length) {
    container.appendChild(el("p", "empty", "No results for this race."));
    return;
  }
  if (data.hasSprint) {
    container.appendChild(el("div", "f1-note", "Points shown are the weekend total (race + sprint)."));
  }
  for (const r of results) {
    const row = el("div", "f1-row");
    row.appendChild(el("span", "f1-pos", r.pos));
    const mid = el("div");
    const d = el("span", "f1-driver", r.driver);
    const color = readableTeamColor(r.color);
    if (color) d.style.setProperty("--team", color);
    mid.append(d, document.createTextNode(" "), el("span", "f1-constructor", r.constructor));
    const pts = el("span", "f1-pts", `${r.points} pt${r.points === 1 ? "" : "s"}`);
    row.append(mid, pts, el("span", "f1-time", r.time));
    container.appendChild(row);
  }
}

function f1SessionsList(sessions) {
  const list = el("div", "f1-sessions");
  for (const s of sessions) {
    const iso = `${s.date}T${s.time || "12:00:00Z"}`;
    const row = el("div", "f1-session");
    row.appendChild(el("span", "f1-session-name", s.label));
    row.appendChild(el("span", "f1-session-when", `${dayLabel(iso)} · ${fmtTime(iso)}`));
    list.appendChild(row);
  }
  return list;
}
function nextRaceCard(next) {
  const item = el("div", "f1-next");
  item.appendChild(el("div", "f1-next-label", "Next Race"));
  const title = el("div", "f1-next-title");
  title.append(
    el("span", "f1-race-name", next.name),
    el("span", "f1-race-sub", `R${next.round}${next.country ? " · " + next.country : ""}`)
  );
  item.appendChild(title);
  item.appendChild(f1SessionsList(next.sessions));
  return item;
}
// An upcoming race as an expandable card; body shows its session times.
function f1SessionAccordionItem(race, expanded) {
  const item = el("div", "f1-race");
  const btn = el("button", "f1-race-head");
  btn.type = "button";
  btn.setAttribute("aria-expanded", String(expanded));
  const title = el("div", "f1-race-title");
  title.append(
    el("span", "f1-race-name", race.name),
    el("span", "f1-race-sub", `R${race.round} · ${dayLabel(race.date)}${race.country ? " · " + race.country : ""}`)
  );
  btn.append(title, el("span", "f1-race-chevron", expanded ? "▾" : "▸"));
  const body = el("div", "f1-race-body");
  body.hidden = !expanded;
  body.appendChild(f1SessionsList(race.sessions));
  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!open));
    btn.querySelector(".f1-race-chevron").textContent = open ? "▸" : "▾";
    body.hidden = open;
  });
  item.append(btn, body);
  return item;
}

// One completed race as a collapsed accordion; results load lazily on expand.
function f1RaceAccordionItem(race) {
  const item = el("div", "f1-race");
  const btn = el("button", "f1-race-head");
  btn.type = "button";
  btn.setAttribute("aria-expanded", "false");
  const title = el("div", "f1-race-title");
  title.append(
    el("span", "f1-race-name", race.name),
    el("span", "f1-race-sub", `R${race.round} · ${dayLabel(race.date)}${race.country ? " · " + race.country : ""}`)
  );
  btn.append(title, el("span", "f1-race-chevron", "▸"));
  const body = el("div", "f1-race-body");
  body.hidden = true;

  btn.addEventListener("click", async () => {
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!open));
    btn.querySelector(".f1-race-chevron").textContent = open ? "▸" : "▾";
    body.hidden = open;
    if (!open && !body.dataset.loaded) {
      body.appendChild(el("div", "f1-loading", "Loading…"));
      try {
        const results = await fetchF1RoundResults(race.round);
        f1ResultRows(body, results);
        body.dataset.loaded = "1";
      } catch {
        body.replaceChildren(el("p", "error", "Couldn't load results."));
      }
    }
  });

  item.append(btn, body);
  return item;
}

// Results tab: the next race up top (one click to see it), then completed races
// (collapsed so an unwatched race can't spoil).
function renderF1Results(data) {
  const c = scoresEl();
  const next = data?.next;
  const races = data?.past || [];
  if (!next && !races.length) { c.replaceChildren(el("p", "empty", "No races yet this season.")); return; }
  const frag = document.createDocumentFragment();
  if (next) frag.appendChild(nextRaceCard(next));
  for (const race of races) frag.appendChild(f1RaceAccordionItem(race));
  c.replaceChildren(frag);
}

// Schedule tab: every upcoming race as an expandable card of session times.
// The next race is expanded by default; the rest open on click.
function renderF1ScheduleView(data) {
  const c = scoresEl();
  const upcoming = data?.upcoming || [];
  if (!upcoming.length) { c.replaceChildren(el("p", "empty", "No upcoming races scheduled.")); return; }
  const frag = document.createDocumentFragment();
  upcoming.forEach((race, i) => frag.appendChild(f1SessionAccordionItem(race, i === 0)));
  c.replaceChildren(frag);
}

/* ---------- Render: standings ---------- */
function renderStandings(groups) {
  const c = scoresEl();
  if (!groups || !groups.length) { c.replaceChildren(el("p", "empty", "No standings available.")); return; }
  // F1 (Drivers + Constructors) sits side by side; everything else stacks.
  const twoCol = groups.length > 1 && groups.every((g) => g.f1);
  const wrap = el("div", twoCol ? "standings standings-cols" : "standings");
  for (const g of groups) {
    const grp = el("div", "standings-group");
    grp.appendChild(el("div", "standings-group-title", g.title));
    g.entries.forEach((e, i) => {
      const row = el("div", "st-row");
      row.appendChild(el("span", "st-rank", String(i + 1)));
      const team = el("span", "st-team", e.name);
      const color = readableTeamColor(e.color);
      if (color) team.style.setProperty("--team", color);
      if (g.f1 && e.sub) { // driver + constructor
        const box = el("div");
        box.append(team, document.createTextNode(" "), el("span", "f1-constructor", e.sub));
        row.appendChild(box);
      } else {
        row.appendChild(team);
      }
      const figs = el("div", "st-figs");
      if (g.f1) {
        figs.append(bold(e.points), muted(`${e.wins} W`));
      } else {
        figs.append(bold(`${e.wins}-${e.losses}`), muted(e.pct || ""));
        if (e.gb && e.gb !== "-") figs.append(muted(`GB ${e.gb}`));
      }
      row.appendChild(figs);
      grp.appendChild(row);
    });
    wrap.appendChild(grp);
  }
  c.replaceChildren(wrap);
}
function bold(text) { const b = el("b", null, String(text ?? "")); return b; }
function muted(text) { return el("span", "muted", String(text ?? "")); }

/* ---------- Render: news ---------- */
function renderNews(items) {
  const c = newsEl();
  if (!items || !items.length) { c.replaceChildren(el("p", "empty", "No news right now.")); return; }
  const frag = document.createDocumentFragment();
  for (const a of items) {
    const art = el("div", "article");
    if (a.href) {
      const link = el("a", null, a.headline);
      link.href = a.href; link.target = "_blank"; link.rel = "noopener noreferrer";
      art.appendChild(link);
    } else {
      art.appendChild(el("span", null, a.headline));
    }
    if (a.desc) art.appendChild(el("p", "desc", a.desc));
    const meta = el("div", "article-meta");
    const src = sourceLabel(a.source);
    if (src) meta.appendChild(el("span", "article-source", src));
    if (a.published) {
      if (src) meta.appendChild(el("span", "dot", "·"));
      meta.appendChild(el("span", "date", fmtDate(a.published)));
    }
    if (meta.childNodes.length) art.appendChild(meta);
    frag.appendChild(art);
  }
  c.replaceChildren(frag);
}

/* ---------- Orchestration ---------- */
// All views are kept cached and refreshed on their own cadence, so switching
// sub-tabs is always instant: scores every POLL_MS (they can be live), standings
// at most every STANDINGS_TTL (they only move when a game finishes).
const cache = { sport: null, results: null, standings: null, standingsAt: 0, news: null };
const STANDINGS_TTL = 5 * 60_000;

function rerenderScores() {
  // Re-render current view from cache (used on theme toggle & view switch).
  const sport = SPORTS.find((s) => s.key === cache.sport);
  if (!sport) return;
  if (activeView === "standings") return renderStandings(cache.standings);
  if (sport.kind === "f1") {
    return activeView === "schedule"
      ? renderF1ScheduleView(cache.results)
      : renderF1Results(cache.results);
  }
  return activeView === "schedule" ? renderSchedule(cache.results) : renderResults(cache.results);
}
const onScoresView = () => activeView === "results" || activeView === "schedule";

// Scoreboard (Results + Schedule share this). Refetched each poll for liveness.
async function refreshScores(sport, { skeleton = false } = {}) {
  if (skeleton && onScoresView()) skeletons(scoresEl());
  try {
    // F1 race list is static within a session; don't refetch on polls (keeps
    // accordion expand state, and races only shift after one actually finishes).
    if (sport.kind === "f1" && cache.results && !skeleton) return;
    const data = sport.kind === "f1" ? await fetchF1Schedule() : await fetchBallScores(sport);
    if (activeSport !== sport.key) return;
    cache.results = data;
    if (onScoresView()) rerenderScores();
  } catch {
    if (activeSport === sport.key && onScoresView() && !cache.results)
      scoresEl().replaceChildren(el("p", "error", "Couldn't load — will retry."));
  }
}

// Standings change slowly — skip the fetch entirely if the cache is still fresh.
async function refreshStandings(sport, { skeleton = false, force = false } = {}) {
  const fresh = cache.standings && Date.now() - cache.standingsAt < STANDINGS_TTL;
  if (fresh && !force) {
    if (skeleton && activeView === "standings") rerenderScores();
    return;
  }
  if (skeleton && activeView === "standings") skeletons(scoresEl());
  try {
    const groups = sport.kind === "f1" ? await fetchF1Standings() : await fetchBallStandings(sport);
    if (activeSport !== sport.key) return;
    cache.standings = groups;
    cache.standingsAt = Date.now();
    if (activeView === "standings") rerenderScores();
  } catch {
    if (activeSport === sport.key && activeView === "standings" && !cache.standings)
      scoresEl().replaceChildren(el("p", "error", "Couldn't load — will retry."));
  }
}

async function loadNews(sport, { showSkeleton } = {}) {
  if (showSkeleton) skeletons(newsEl());
  try {
    const items = await fetchNews(sport);
    if (activeSport !== sport.key) return;
    cache.news = items;
    renderNews(items);
  } catch (e) {
    if (activeSport === sport.key) newsEl().replaceChildren(el("p", "error", "Couldn't load news."));
  }
}

// Initial load for a sport: warm every view (scores, standings, news) at once,
// so all sub-tabs are ready. Only the active view shows a skeleton.
async function load(sportKey) {
  const sport = SPORTS.find((s) => s.key === sportKey);
  if (!sport) return;
  cache.sport = sportKey;
  await Promise.allSettled([
    refreshScores(sport, { skeleton: true }),
    refreshStandings(sport, { skeleton: true, force: true }),
    loadNews(sport, { showSkeleton: true }),
  ]);
  if (activeSport === sportKey) {
    $("#status-line").textContent = `Updated ${fmtTime(new Date().toISOString())}`;
  }
}

function startPolling(key) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const sport = SPORTS.find((s) => s.key === key);
    if (!sport) return;
    await Promise.allSettled([
      refreshScores(sport, { skeleton: false }),
      refreshStandings(sport, { skeleton: false }), // TTL-gated inside
      loadNews(sport, { showSkeleton: false }),
    ]);
    if (activeSport === key) {
      $("#status-line").textContent = `Updated ${fmtTime(new Date().toISOString())}`;
    }
  }, POLL_MS);
}

function selectSport(key) {
  activeSport = key;
  activeView = "results"; // always land on Results; don't remember prior view
  document.querySelectorAll(".tab").forEach((t) =>
    t.setAttribute("aria-selected", String(t.dataset.key === key)));
  document.querySelectorAll(".subtab").forEach((t) =>
    t.setAttribute("aria-selected", String(t.dataset.view === "results")));
  cache.results = cache.standings = cache.news = null;
  cache.standingsAt = 0;
  load(key);
  startPolling(key);
}

function selectView(view) {
  if (view === activeView) return;
  activeView = view;
  document.querySelectorAll(".subtab").forEach((t) =>
    t.setAttribute("aria-selected", String(t.dataset.view === view)));
  const sport = SPORTS.find((s) => s.key === activeSport);
  // Prewarmed by load()/polling — render from cache instantly when we can.
  if (view === "standings") {
    cache.standings ? rerenderScores() : refreshStandings(sport, { skeleton: true, force: true });
  } else {
    cache.results ? rerenderScores() : refreshScores(sport, { skeleton: true });
  }
}

// Each sport is its own path: /mlb, /nba, /f1. Root falls back to the first sport.
function sportFromPath() {
  const seg = location.pathname.split("/").filter(Boolean)[0];
  return SPORTS.some((s) => s.key === seg) ? seg : SPORTS[0].key;
}
function setTitle(key) {
  const s = SPORTS.find((x) => x.key === key);
  document.title = s ? `JustSports · ${s.label}` : "JustSports";
}
function navigateSport(key) {
  if (key !== activeSport) history.pushState({ sport: key }, "", `/${key}`);
  setTitle(key);
  selectSport(key);
}

function buildTabs() {
  const nav = $(".tabs");
  for (const s of SPORTS) {
    // Real links so they're shareable / open-in-new-tab, with in-page nav on click.
    const a = el("a", "tab", s.label);
    a.href = `/${s.key}`; a.setAttribute("role", "tab"); a.dataset.key = s.key;
    a.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      navigateSport(s.key);
    });
    nav.appendChild(a);
  }
  document.querySelectorAll(".subtab").forEach((t) =>
    t.addEventListener("click", () => selectView(t.dataset.view)));
}

/* ---------- Boot ---------- */
initTheme();
buildTabs();
const initialSport = sportFromPath();
setTitle(initialSport);
selectSport(initialSport);

// Back/forward navigation between sports.
window.addEventListener("popstate", () => {
  const key = sportFromPath();
  setTitle(key);
  selectSport(key);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearInterval(pollTimer); return; }
  // Back in focus: silent refresh (no skeleton — we already have cached data).
  const sport = SPORTS.find((s) => s.key === activeSport);
  if (sport) {
    refreshScores(sport, { skeleton: false });
    refreshStandings(sport, { skeleton: false });
    loadNews(sport, { showSkeleton: false });
  }
  startPolling(activeSport);
});
