// Daily snapshot job for Genrebase.
//
// What it does each run:
//   1. Builds the track list: public/data/tracks.json plus your top Last.fm tracks.
//   2. Pulls total plays and listeners from Last.fm.
//   3. Pulls views and likes from YouTube.
//   4. Saves today's totals in public/data/history.json.
//   5. Computes daily and 7 day change from earlier snapshots.
//   6. Writes public/data/latest.js, which the site reads.
//
// Env vars:
//   LASTFM_API_KEY   Last.fm API key (needed for plays)
//   LASTFM_USER      your Last.fm username (optional, adds your top tracks)
//   YOUTUBE_API_KEY  YouTube Data API key (needed for views and likes)
//   TODAY            override the snapshot date, YYYY-MM-DD (testing only)
//   DATA_DIR         override the data folder (testing only)
//   MAX_YT_RESOLVE   new YouTube matches to look up per run (default 60)
//   TOP_MINE         how many of your Last.fm top tracks to add (default 50)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'public', 'data');

const LFM_KEY = process.env.LASTFM_API_KEY || '';
const LFM_USER = process.env.LASTFM_USER || '';
const YT_KEY = process.env.YOUTUBE_API_KEY || '';
const TODAY = process.env.TODAY || new Date().toISOString().slice(0, 10);
const MAX_YT_RESOLVE = parseInt(process.env.MAX_YT_RESOLVE || '60', 10);
const TOP_MINE = parseInt(process.env.TOP_MINE || '50', 10);

if (!LFM_KEY && !YT_KEY) {
  console.error('Set LASTFM_API_KEY and or YOUTUBE_API_KEY first.');
  process.exit(1);
}

/* ---------- small helpers ---------- */
const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); }
  catch { return fallback; }
};
const writeJson = (f, v, pretty) =>
  fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, pretty ? 2 : 0) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pace = ms => (process.env.NO_PAUSE ? Promise.resolve() : sleep(ms));  // polite gap between calls
const norm = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const keyOf = (la, t) => norm(la) + '|' + norm(t);
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);

// Never log URLs. They contain API keys.
async function getJson(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status >= 500 || r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      return await r.json();
    } catch (e) {
      if (i === tries - 1) return { error: -1, message: String(e.message || e) };
      await sleep(1000);
    }
  }
  return { error: -1, message: 'request failed' };
}

/* ---------- Last.fm ---------- */
const LFM = 'https://ws.audioscrobbler.com/2.0/';
const lfmUrl = (method, params) =>
  LFM + '?' + new URLSearchParams({ method, api_key: LFM_KEY, format: 'json', ...params });

async function lfmInfo(artist, track) {
  const j = await getJson(lfmUrl('track.getInfo', { artist, track, autocorrect: '1' }));
  if (j && j.track) return { plays: Number(j.track.playcount) || 0, listeners: Number(j.track.listeners) || 0 };
  return null;
}
async function lfmSearch(artist, track) {
  const j = await getJson(lfmUrl('track.search', { track, artist, limit: '1' }));
  const m = j && j.results && j.results.trackmatches && j.results.trackmatches.track;
  const first = Array.isArray(m) ? m[0] : m;
  return first ? { artist: first.artist, track: first.name } : null;
}
async function lfmFor(tr, matches) {
  const known = matches.lfm[tr.key];
  let r = await lfmInfo(known ? known.artist : tr.la, known ? known.track : tr.t);
  if (!r && !known) {
    const s = await lfmSearch(tr.la, tr.t);
    if (s) {
      r = await lfmInfo(s.artist, s.track);
      if (r) matches.lfm[tr.key] = { artist: s.artist, track: s.track };
    }
  }
  return r;
}
async function myTopTracks() {
  if (!LFM_KEY || !LFM_USER) return [];
  const j = await getJson(lfmUrl('user.getTopTracks', { user: LFM_USER, period: 'overall', limit: String(TOP_MINE) }));
  let list = j && j.toptracks && j.toptracks.track;
  if (!list) return [];
  if (!Array.isArray(list)) list = [list];
  return list.map(x => ({ t: x.name, a: x.artist.name, la: x.artist.name, mine: true }));
}

/* ---------- YouTube ---------- */
const YT = 'https://www.googleapis.com/youtube/v3/';
let ytQuotaHit = false;
async function ytSearch(q) {
  const j = await getJson(YT + 'search?' + new URLSearchParams({
    part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: '1', q, key: YT_KEY
  }));
  if (j && j.error) {
    const reason = j.error.errors && j.error.errors[0] && j.error.errors[0].reason;
    if ((reason === 'quotaExceeded' || j.error.code === 403) && !ytQuotaHit) {
      console.warn('YouTube refused a request. Check the key, that YouTube Data API v3 is enabled, and the daily quota.');
      ytQuotaHit = true;
    }
    return null;
  }
  return (j && j.items && j.items[0] && j.items[0].id && j.items[0].id.videoId) || null;
}
async function ytStats(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const j = await getJson(YT + 'videos?' + new URLSearchParams({
      part: 'statistics', id: ids.slice(i, i + 50).join(','), key: YT_KEY
    }));
    for (const it of (j && j.items) || []) {
      const s = it.statistics || {};
      out[it.id] = {
        views: s.viewCount != null ? Number(s.viewCount) : null,
        likes: s.likeCount != null ? Number(s.likeCount) : null   // hidden likes come back missing
      };
    }
  }
  return out;
}

/* ---------- build the track list ---------- */
fs.mkdirSync(DATA, { recursive: true });
const base = readJson('tracks.json', []);
const mine = await myTopTracks();
const byKey = new Map();
for (const t of base) {
  const k = keyOf(t.la || t.a, t.t);
  byKey.set(k, { ...t, la: t.la || t.a, key: k, chart: true, mine: false });
}
for (const t of mine) {
  const k = keyOf(t.la, t.t);
  if (byKey.has(k)) byKey.get(k).mine = true;
  else byKey.set(k, { ...t, key: k, chart: false, mine: true });
}
const tracks = [...byKey.values()];
console.log(`Tracking ${tracks.length} songs (${base.length} from the chart list, ${mine.length} from Last.fm).`);

const matches = readJson('matches.json', { yt: {}, lfm: {} });
matches.yt = matches.yt || {};
matches.lfm = matches.lfm || {};

/* ---------- Last.fm pass ---------- */
const lfmData = {};
if (LFM_KEY) {
  for (const tr of tracks) {
    lfmData[tr.key] = await lfmFor(tr, matches);
    await pace(220);
  }
}

/* ---------- YouTube pass ---------- */
const ytIds = {};
let ytStatsById = {};
if (YT_KEY) {
  let resolved = 0;
  for (const tr of tracks) {
    if (matches.yt[tr.key]) continue;
    if (resolved >= MAX_YT_RESOLVE || ytQuotaHit) continue;
    const id = await ytSearch(`${tr.la} ${tr.t} official video`);
    resolved++;
    if (id) matches.yt[tr.key] = id;
    await pace(100);
  }
  for (const tr of tracks) if (matches.yt[tr.key]) ytIds[tr.key] = matches.yt[tr.key];
  ytStatsById = await ytStats([...new Set(Object.values(ytIds))]);
}

/* ---------- save today's snapshot ---------- */
const history = readJson('history.json', {});
const todaySnap = history[TODAY] || {};
let got = 0;
for (const tr of tracks) {
  const e = {};
  const lf = lfmData[tr.key];
  if (lf) e.lf = { p: lf.plays, l: lf.listeners };
  const ys = ytIds[tr.key] && ytStatsById[ytIds[tr.key]];
  if (ys) e.yt = { v: ys.views, k: ys.likes };
  if (Object.keys(e).length) {
    todaySnap[tr.key] = { ...(todaySnap[tr.key] || {}), ...e };
    got++;
  }
}
if (tracks.length && got === 0) {
  console.error('No data came back from any API. Nothing saved. Check the keys and quotas.');
  process.exit(1);
}
history[TODAY] = todaySnap;

/* ---------- compute change ---------- */
const dates = Object.keys(history).sort();
const prior = dates.filter(d => d < TODAY);

// Most recent earlier snapshot that has this value, with the gap in days.
function prevValue(key, getter) {
  for (let i = prior.length - 1; i >= 0; i--) {
    const v = getter(history[prior[i]][key]);
    if (v != null) return { v, gap: Math.max(1, dayDiff(TODAY, prior[i])) };
  }
  return null;
}
// Value from about a week ago: latest snapshot at least 7 days old, at most 10.
function weekValue(key, getter) {
  for (let i = prior.length - 1; i >= 0; i--) {
    const gap = dayDiff(TODAY, prior[i]);
    if (gap < 7) continue;
    if (gap > 10) return null;
    const v = getter(history[prior[i]][key]);
    if (v != null) return v;
  }
  return null;
}
function change(key, cur, getter) {
  if (cur == null) return { d1: null, d7: null };
  const p = prevValue(key, getter);
  const w = weekValue(key, getter);
  return {
    d1: p ? Math.round((cur - p.v) / p.gap) : null,  // per day, even if a run was missed
    d7: w != null ? cur - w : null
  };
}

const rows = tracks.map(tr => {
  const s = todaySnap[tr.key] || {};
  let lf = null;
  if (s.lf) {
    const c = change(tr.key, s.lf.p, e => e && e.lf && e.lf.p);
    lf = { p: s.lf.p, l: s.lf.l, d1: c.d1, d7: c.d7 };
  }
  let yt = null;
  if (s.yt) {
    const cv = change(tr.key, s.yt.v, e => e && e.yt && e.yt.v);
    const ck = change(tr.key, s.yt.k, e => e && e.yt && e.yt.k);
    yt = { v: s.yt.v, k: s.yt.k, vd1: cv.d1, vd7: cv.d7, kd1: ck.d1, kd7: ck.d7, id: ytIds[tr.key] || null };
  }
  return { k: tr.key, t: tr.t, a: tr.a, chart: !!tr.chart, mine: !!tr.mine, lf, yt };
});

const latest = { updated: new Date().toISOString(), date: TODAY, days: dates.length, rows };

writeJson('history.json', history, false);
writeJson('matches.json', matches, true);
fs.writeFileSync(path.join(DATA, 'latest.js'), 'window.GB_LATEST=' + JSON.stringify(latest) + ';\n');

const withLf = rows.filter(r => r.lf).length;
const withYt = rows.filter(r => r.yt).length;
console.log(`Saved ${TODAY}: Last.fm data for ${withLf} songs, YouTube data for ${withYt}. ${dates.length} day(s) of history.`);
if (YT_KEY && tracks.length - Object.keys(ytIds).length > 0) {
  console.log(`${tracks.length - Object.keys(ytIds).length} songs still need a YouTube match. They fill in over the next runs.`);
}
