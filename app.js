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
  { key: "imsa", label: "IMSA", kind: "imsa" },
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
// Some teams' primary brand color (per ESPN) is literally black or white (e.g. SF
// Giants' primary is "000000") — a color with no hue at all, which our normalization
// can't tint, so it renders as flat gray indistinguishable from a dimmed loser. Detect
// that and prefer the alternate color instead.
function isGrayscale(rgb) {
  return Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b) < 20;
}
function pickTeamColor(t) {
  const primary = t.color ? hexToRgb(t.color) : null;
  if (primary && !isGrayscale(primary)) return `#${t.color}`;
  const alt = t.alternateColor ? hexToRgb(t.alternateColor) : null;
  if (alt && !isGrayscale(alt)) return `#${t.alternateColor}`;
  return t.color ? `#${t.color}` : t.alternateColor ? `#${t.alternateColor}` : null;
}
function luminance({ r, g, b }) {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
const rgbStr = ({ r, g, b }) => `rgb(${r}, ${g}, ${b})`;
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}
function hslToRgb({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

// Team brand colors span a huge luminance/saturation range (a near-black navy
// next to a fully-saturated cyan), and MLB/NBA hand us whatever hex they use
// for jerseys. A single legibility threshold treats colors just above/below
// the cutoff totally differently, so some teams read as bold and others
// washed-out, and fully-saturated brand colors read as loud/neon against a
// calm UI. So: cap saturation for a muted look, then walk lightness until
// perceptual luminance lands in a band — every team ends up similarly muted
// and similarly bold, just distinguished by hue.
function readableTeamColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [lo, hi] = isDark() ? [0.12, 0.28] : [0.04, 0.14];
  const hsl = rgbToHsl(rgb);
  hsl.s = Math.min(hsl.s, 0.6);
  let cur = luminance(hslToRgb(hsl));
  let tries = 0;
  while (cur < lo && hsl.l < 0.95 && tries < 60) { hsl.l += 0.02; cur = luminance(hslToRgb(hsl)); tries++; }
  tries = 0;
  while (cur > hi && hsl.l > 0.05 && tries < 60) { hsl.l -= 0.02; cur = luminance(hslToRgb(hsl)); tries++; }
  return rgbStr(hslToRgb(hsl));
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
        color: pickTeamColor(t),
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
      if (t.abbreviation) map[t.abbreviation] = pickTeamColor(t);
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
        color: pickTeamColor(t) || colors[t.abbreviation] || null,
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
function teamRow(t, showScore, behind, final) {
  const row = el("div", "game-row");
  const name = el("span", "team-name", t.name);
  const color = readableTeamColor(t.color);
  if (color) name.style.setProperty("--team", color);
  if (showScore && behind) name.classList.add("loser");
  // Only a finished game has an actual winner worth calling out; a live leader
  // can still lose, so bolding it would be a promise the game hasn't kept yet.
  if (showScore && final && !behind) name.classList.add("winner");
  row.appendChild(name);
  if (showScore) row.appendChild(el("span", "score", t.score ?? "–"));
  return row;
}
// ESPN's `winner` flag is only meaningful once a game is final — while live it's
// false for both teams, which used to dim both names ("loser" styling) during
// every in-progress game. Use the live score instead, and don't dim on a tie.
function isBehind(g, t) {
  if (g.state === "post") return !t.winner;
  if (g.state === "in") {
    const other = t === g.home ? g.away : g.home;
    return Number(t.score) < Number(other.score);
  }
  return false;
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
  const final = g.state === "post";
  card.appendChild(teamRow(g.away, showScore, isBehind(g, g.away), final));
  card.appendChild(teamRow(g.home, showScore, isBehind(g, g.home), final));
  const meta = el("div", "game-meta");
  if (g.state === "in") {
    // Live games: the start time is irrelevant once play is underway —
    // the inning/clock is what matters, so show that instead, prominently.
    meta.appendChild(el("span", "live-dot", "● LIVE"));
    if (g.detail) meta.appendChild(el("span", "live-detail", g.detail));
  } else {
    if (g.state === "post") meta.appendChild(el("span", "final-tag", "FINAL"));
    meta.appendChild(el("span", null, `${fmtDate(g.date)} · ${fmtTime(g.date)}`));
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
// A live game keeps its start-of-day date, so a game that tips off at 11pm and
// is still going at 12:30am would otherwise fall out of "Today" into
// "Yesterday" the moment the clock rolls over — silly, since it's still being
// played right now. Group/label live games by the current moment instead.
function groupIso(g) {
  return g.state === "in" ? new Date().toISOString() : g.date;
}
function renderDayGroups(games, emptyMsg) {
  const c = scoresEl();
  if (!games || !games.length) { c.replaceChildren(el("p", "empty", emptyMsg)); return; }
  // Group by calendar day.
  const byDay = new Map();
  for (const g of games) {
    const k = dayKey(groupIso(g));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(g);
  }
  const days = [...byDay.entries()].sort((a, b) => {
    const [ga, sa] = dayOrderKey(groupIso(a[1][0]));
    const [gb, sb] = dayOrderKey(groupIso(b[1][0]));
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
    const isToday = dayDiff(groupIso(dayGames[0])) === 0;
    const group = el("div", isToday ? "day-group today" : "day-group");
    group.appendChild(el("div", "day-header", dayLabel(groupIso(dayGames[0]))));
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
function f1RaceAccordionItem(race, isLast) {
  const item = el("div", isLast ? "f1-race last-race" : "f1-race");
  if (isLast) item.appendChild(el("div", "f1-last-label", "Last Race"));
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
  races.forEach((race, i) => frag.appendChild(f1RaceAccordionItem(race, i === 0)));
  c.replaceChildren(frag);
}

// Schedule tab: the next race as the same non-collapsible "Next Race" card used
// in Results, then the rest as expandable accordions of session times.
function renderF1ScheduleView(data) {
  const c = scoresEl();
  const upcoming = data?.upcoming || [];
  if (!upcoming.length) { c.replaceChildren(el("p", "empty", "No upcoming races scheduled.")); return; }
  const frag = document.createDocumentFragment();
  // First race gets the same non-collapsible "Next Race" card as the Results tab.
  frag.appendChild(nextRaceCard(upcoming[0]));
  upcoming.slice(1).forEach((race) => frag.appendChild(f1SessionAccordionItem(race, false)));
  c.replaceChildren(frag);
}

/* ---------- IMSA ---------- */
// IMSA's own site is bot-protected, but its official timing/results system
// (Al Kamel, same vendor most endurance series use) is a plain, unauthenticated
// static file tree — no key, no scraping fragile marketing HTML. It has no
// forward schedule (folders only appear once an event happens), so Results and
// Standings only for now. Proxied same-origin via nginx at /imsa/ since the
// upstream sends no CORS headers.
const IMSA_SERIES = [
  { key: "mx5", label: "MX-5 Cup", match: "mx-5 cup" },
  { key: "pilot", label: "Pilot Challenge", match: "michelin pilot challenge" },
  { key: "weathertech", label: "WeatherTech Champ.", match: "weathertech sportscar championship" },
];
let activeImsaSeries = "mx5";
const currentImsaSeries = () => IMSA_SERIES.find((s) => s.key === activeImsaSeries) || IMSA_SERIES[0];

function imsaUrl(path) {
  return "/imsa-data/" + path.split("/").map((seg) => (seg ? encodeURIComponent(seg) : "")).join("/");
}
// Results only change once a whole new event posts (roughly biweekly), so
// cache every directory listing and JSON file in localStorage for a day —
// turns the season walk (dozens of requests) into a single instant read on
// every visit after the first.
const IMSA_CACHE_TTL = 24 * 60 * 60_000;
function imsaCacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const { at, data } = JSON.parse(raw);
    if (Date.now() - at > IMSA_CACHE_TTL) return undefined;
    return data;
  } catch { return undefined; }
}
function imsaCacheSet(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch { /* quota/private-mode: skip */ }
}
async function imsaJson(path) {
  const key = "imsa-json:" + path;
  const cached = imsaCacheGet(key);
  if (cached !== undefined) return cached;
  const text = await (await fetch(imsaUrl(path))).text();
  const data = JSON.parse(text.replace(/^\uFEFF/, ""));
  imsaCacheSet(key, data);
  return data;
}
// The results host serves plain Apache directory listings — parse the <a href>
// entries, skipping the sort-column links (?C=...) and the parent-dir link.
async function imsaDir(path) {
  const key = "imsa-dir:" + path;
  const cached = imsaCacheGet(key);
  if (cached !== undefined) return cached;
  const html = await (await fetch(imsaUrl(path))).text();
  const items = [];
  const re = /<a href="([^"?][^"]*)">/g;
  let m;
  while ((m = re.exec(html))) {
    const href = decodeURIComponent(m[1]);
    if (href.startsWith("/")) continue; // parent-directory link
    items.push({ name: href.replace(/\/$/, ""), isDir: href.endsWith("/") });
  }
  imsaCacheSet(key, items);
  return items;
}
// Walk every venue to find which ones this series raced (not every series
// races every weekend) — in parallel, since each venue's listing is
// independent. Cached per series for the session on top of the localStorage
// layer above.
const _imsaSeasonCache = {};
async function imsaSeasonEvents(seriesCfg) {
  if (_imsaSeasonCache[seriesCfg.key]) return _imsaSeasonCache[seriesCfg.key];
  const seasons = (await imsaDir("Results/")).filter((i) => i.isDir).sort((a, b) => b.name.localeCompare(a.name));
  if (!seasons.length) return [];
  const season = seasons[0].name;
  const venues = (await imsaDir(`Results/${season}/`)).filter((i) => i.isDir)
    .sort((a, b) => parseInt(b.name) - parseInt(a.name));
  const perVenue = await Promise.all(venues.map(async (v) => {
    const series = await imsaDir(`Results/${season}/${v.name}/`);
    const match = series.find((s) => s.isDir && s.name.toLowerCase().includes(seriesCfg.match));
    return match ? { venue: v.name.replace(/^\d+_/, ""), eventPath: `Results/${season}/${v.name}/${match.name}/` } : null;
  }));
  const events = perVenue.filter(Boolean);
  _imsaSeasonCache[seriesCfg.key] = events;
  return events;
}
// A session folder is timestamp-prefixed, e.g. "202608221745_Race 1" — parse
// that (not the JSON's own session_date, which is in an ambiguous/possibly
// wrong timezone) for a reliable, honest "when" display.
function imsaSessionWhen(folderName) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(folderName);
  if (!m) return "";
  const [, y, mo, d, h, mi] = m;
  const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:00`);
  return `${dt.toLocaleDateString([], { month: "short", day: "numeric" })} · ${dt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}
// One event's race session(s) (a double-header has two) — fetched lazily on
// accordion expand, same pattern as F1's past-race results.
async function imsaEventRaces(eventPath) {
  const items = await imsaDir(eventPath);
  // Session folders are timestamp-prefixed, e.g. "202608221745_Race 1".
  const raceDirs = items.filter((i) => i.isDir && /race/i.test(i.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const races = [];
  for (const r of raceDirs) {
    const files = await imsaDir(eventPath + r.name + "/");
    const resultFile = files.find((f) => !f.isDir && /^03_results.*\.json$/i.test(f.name));
    if (resultFile) races.push({ folder: r.name, data: await imsaJson(eventPath + r.name + "/" + resultFile.name) });
  }
  return races;
}
async function fetchImsaStandings(seriesCfg) {
  const events = await imsaSeasonEvents(seriesCfg);
  const eventPath = events[0]?.eventPath;
  if (!eventPath) return null;
  const items = await imsaDir(eventPath);
  const pointsDir = items.find((i) => i.isDir && /points.*data/i.test(i.name));
  if (!pointsDir) return null;
  const files = (await imsaDir(eventPath + pointsDir.name + "/"))
    .filter((f) => !f.isDir && /drivers\.json$/i.test(f.name) && !/award/i.test(f.name));
  const groups = [];
  for (const f of files) {
    // "IWSC 01 GTP Drivers.json" -> class "GTP"; "MX-5 01 Drivers.json" -> single class.
    // The "01a"-style secondary listings (e.g. GTD-Am splits) are skipped.
    const m = f.name.match(/^\S+\s+\d+\s+(?:([A-Za-z0-9-]+)\s+)?Drivers\.json$/i);
    if (!m) continue;
    const data = await imsaJson(eventPath + pointsDir.name + "/" + f.name);
    const entries = (data.classification || [])
      .sort((a, b) => a.position - b.position)
      .map((e) => ({ name: e.key, points: Math.round(e.total_points) }));
    if (entries.length) groups.push({ title: m[1] || seriesCfg.label, pointsOnly: true, entries });
  }
  return groups;
}
function imsaResultRows(container, races) {
  if (!races.length) { container.appendChild(el("p", "error", "No results posted for this event.")); return; }
  races.forEach((race, i) => {
    const s = race.data.session || {};
    const head = el("div", "f1-head game-row");
    if (i > 0) head.style.marginTop = "14px";
    head.append(
      el("span", null, s.session_name || "Race"),
      el("span", "f1-session-when", imsaSessionWhen(race.folder))
    );
    container.appendChild(head);
    (race.data.classification || []).slice(0, 20).forEach((e) => {
      const driver = (e.drivers || []).map((d) => `${d.firstname} ${d.surname}`).join(" / ");
      const row = el("div", "f1-row");
      row.appendChild(el("span", "f1-pos", String(e.position)));
      row.appendChild(el("span", "f1-driver", driver || `#${e.number}`));
      row.appendChild(el("span", "f1-constructor", `${e.team || ""} · ${e.class || ""}`));
      row.appendChild(el("span", "f1-time", e.gap_first === "-" ? "Winner" : e.gap_first || ""));
      container.appendChild(row);
    });
  });
}
// One completed event as a collapsed accordion; results load lazily on expand
// (mirrors f1RaceAccordionItem — same reasoning: an unwatched race can't spoil).
function imsaEventAccordionItem(event) {
  const item = el("div", "f1-race");
  const btn = el("button", "f1-race-head");
  btn.type = "button";
  btn.setAttribute("aria-expanded", "false");
  const title = el("div", "f1-race-title");
  title.append(el("span", "f1-race-name", event.venue));
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
        const races = await imsaEventRaces(event.eventPath);
        body.replaceChildren();
        imsaResultRows(body, races);
        body.dataset.loaded = "1";
      } catch {
        body.replaceChildren(el("p", "error", "Couldn't load results."));
      }
    }
  });

  item.append(btn, body);
  return item;
}
function renderImsaResults(events) {
  const c = scoresEl();
  if (!events || !events.length) { c.replaceChildren(el("p", "empty", "No race results yet this season.")); return; }
  const frag = document.createDocumentFragment();
  for (const event of events) frag.appendChild(imsaEventAccordionItem(event));
  c.replaceChildren(frag);
}

/* ---------- Render: standings ---------- */
function renderStandings(groups) {
  const c = scoresEl();
  if (!groups || !groups.length) { c.replaceChildren(el("p", "empty", "No standings available.")); return; }
  // Multi-group standings (F1's Drivers+Constructors, IMSA's per-class tables)
  // sit side by side; single-table sports (MLB/NBA divisions) stack.
  const twoCol = groups.length > 1 && groups.every((g) => g.f1 || g.pointsOnly);
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
      if (g.pointsOnly) {
        figs.append(bold(e.points));
      } else if (g.f1) {
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
  if (sport.kind === "imsa") return renderImsaResults(cache.results);
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
    // F1's race list and IMSA's results are static within a session; don't
    // refetch on polls (F1 keeps accordion expand state; IMSA has no live
    // scoring anyway — results only change once a whole new event posts).
    if ((sport.kind === "f1" || sport.kind === "imsa") && cache.results && !skeleton) return;
    const data = sport.kind === "f1" ? await fetchF1Schedule()
      : sport.kind === "imsa" ? await imsaSeasonEvents(currentImsaSeries())
      : await fetchBallScores(sport);
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
    const groups = sport.kind === "f1" ? await fetchF1Standings()
      : sport.kind === "imsa" ? await fetchImsaStandings(currentImsaSeries())
      : await fetchBallStandings(sport);
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
  if (sport.kind === "imsa") return; // no news source for IMSA; column is hidden for this sport
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
  const isImsa = SPORTS.find((s) => s.key === key)?.kind === "imsa";
  // IMSA has no forward schedule (yet) and no news source — hide those, show the series picker instead.
  $('.subtab[data-view="schedule"]').hidden = isImsa;
  $("#news-col").hidden = isImsa;
  $("#imsa-series").hidden = !isImsa;
  cache.results = cache.standings = cache.news = null;
  cache.standingsAt = 0;
  load(key);
  startPolling(key);
}

function selectImsaSeries(key) {
  if (key === activeImsaSeries) return;
  activeImsaSeries = key;
  cache.results = cache.standings = null;
  cache.standingsAt = 0;
  load(activeSport);
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

  const seriesSelect = $("#imsa-series");
  for (const s of IMSA_SERIES) seriesSelect.appendChild(new Option(s.label, s.key));
  seriesSelect.value = activeImsaSeries;
  seriesSelect.addEventListener("change", () => selectImsaSeries(seriesSelect.value));
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
