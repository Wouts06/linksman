import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { MapContainer, TileLayer, Marker, CircleMarker, useMapEvents } from "react-leaflet";
import L from "leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

/* Vite/webpack break Leaflet's default marker icon URLs — point them at the bundled assets */
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

/* ---------- design tokens ---------- */
const C = {
  ink: "#24261F",
  paper: "#F5F1E6",
  paper2: "#EDE7D6",
  fairway: "#1E3A2B",
  fairwayDark: "#152A20",
  turf: "#3F6B4A",
  turfLight: "#5C8A63",
  flag: "#B23A2E",
  brass: "#A98B4F",
  line: "#C9C2AC",
  white: "#FBF9F2",
  team1: "#1E3A2B",
  team2: "#7A4A1E",
};
const serif = 'Georgia, "Iowan Old Style", Cambria, "Times New Roman", serif';
const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const sans = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

/* ---------- storage helpers (browser localStorage) ---------- */
function loadKey(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveKey(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error("save failed", key, e);
  }
}

/* ---------- golf math ---------- */
const uid = () => Math.random().toString(36).slice(2, 10);

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}
function haversineYards(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  return haversineMeters(lat1, lon1, lat2, lon2) / 0.9144;
}

/* live GPS position — one shared watcher, only active while `active` is true */
function useLivePosition(active) {
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (!active || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => setPos({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 10000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [active]);
  return pos;
}

/* ---------- golf bag / club suggestion / voice caddy ---------- */
const CLUBS = ["Driver", "3 Wood", "5 Wood", "3 Hybrid", "4 Hybrid", "3 Iron", "4 Iron", "5 Iron", "6 Iron", "7 Iron", "8 Iron", "9 Iron", "PW", "GW", "SW", "LW", "Putter"];

/* spoken-word aliases → canonical club name, checked longest-phrase-first so "six iron" beats a bare "iron" */
const CLUB_ALIASES = {
  "driver": "Driver",
  "3 wood": "3 Wood", "three wood": "3 Wood",
  "5 wood": "5 Wood", "five wood": "5 Wood",
  "3 hybrid": "3 Hybrid", "three hybrid": "3 Hybrid",
  "4 hybrid": "4 Hybrid", "four hybrid": "4 Hybrid",
  "3 iron": "3 Iron", "three iron": "3 Iron",
  "4 iron": "4 Iron", "four iron": "4 Iron",
  "5 iron": "5 Iron", "five iron": "5 Iron",
  "6 iron": "6 Iron", "six iron": "6 Iron",
  "7 iron": "7 Iron", "seven iron": "7 Iron",
  "8 iron": "8 Iron", "eight iron": "8 Iron",
  "9 iron": "9 Iron", "nine iron": "9 Iron",
  "pitching wedge": "PW",
  "gap wedge": "GW",
  "sand wedge": "SW",
  "lob wedge": "LW",
  "putter": "Putter",
};
const CLUB_ALIAS_KEYS = Object.keys(CLUB_ALIASES).sort((a, b) => b.length - a.length);

function matchClubFromSpeech(transcript) {
  const t = (transcript || "").toLowerCase();
  for (const k of CLUB_ALIAS_KEYS) if (t.includes(k)) return CLUB_ALIASES[k];
  return null;
}
/* "Gaddy" is a pun on "caddy" that doesn't transcribe reliably for everyone — letting each
   user pick their own wake word (stored in golf:settings, see the App component) fixes that
   without hardcoding one spelling. Falls back to the original gaddy/caddy/caddie set when no
   custom word has been chosen, so existing behavior is unchanged for anyone who doesn't set one. */
const DEFAULT_WAKE_WORD_PATTERN = /gaddy|caddy|caddie/i;
function wakeWordRegex(customWord) {
  const w = (customWord || "").trim();
  if (!w) return DEFAULT_WAKE_WORD_PATTERN;
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // a typed name could contain regex-special characters
  return new RegExp(escaped, "i");
}
function heardWakeWord(transcript, customWord) {
  return wakeWordRegex(customWord).test(transcript || "");
}
/* "Hey Gaddy, record shot" (or "log/mark shot") — a separate command from naming a club,
   checked before club-matching so "record shot" alone (no club name) still does something. */
function heardRecordShotCommand(transcript) {
  const t = (transcript || "").toLowerCase();
  return /\b(record|log|mark)\s+(my\s+|this\s+)?shot\b/.test(t);
}
function speak(text) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(u);
  } catch {}
}

/* nearest hole to a GPS position, by green location — used to know which hole a voice command applies to */
function nearestHoleByPosition(holes, pos) {
  if (!pos) return null;
  let best = null, bestDist = Infinity;
  (holes || []).forEach((h) => {
    if (h.greenLat == null) return;
    const d = haversineYards(pos.lat, pos.lon, h.greenLat, h.greenLon);
    if (d != null && d < bestDist) { bestDist = d; best = h; }
  });
  return best;
}

/* closest-carry-distance club in a player's bag to the yardage remaining */
function suggestClub(bag, remainingYards) {
  if (!bag || !bag.length || remainingYards == null) return null;
  const candidates = bag.filter((c) => c.club !== "Putter" && c.distanceYards);
  if (!candidates.length) return null;
  let best = null, bestDiff = Infinity;
  candidates.forEach((c) => {
    const diff = Math.abs(c.distanceYards - remainingYards);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  });
  return best ? best.club : null;
}

/* always-listening "Hey Gaddy" voice caddy — wake word + a club name or "record shot" command,
   active only while `active` is true.
   onCommand(kind, payload, transcript) fires for every utterance that contains the wake word,
   with kind one of:
     "club"       — payload is the matched club name, e.g. "6 Iron"
     "recordShot" — "record/log/mark shot" heard, no club named
     "unmatched"  — wake word heard but nothing after it was recognized as a club or command.
     "error"      — the recognizer itself reported an error (payload is its `.error` string,
                    e.g. "network", "not-allowed", "no-speech") — see note below.
   Reporting "unmatched" (rather than silently doing nothing) is deliberate: earlier versions
   only ever called back on a successful club match, so a mis-transcribed or unsupported phrase
   looked identical to the mic simply not picking anything up — genuinely confusing to debug from
   the outside. Surfacing every wake-word-containing transcript, matched or not, lets the on-screen
   voiceMsg show exactly what the recognizer heard, so misfires are visible instead of silent.
   Surfacing "error" closes the other gap: some Chromium-based browsers (Brave is the known one)
   ship the SpeechRecognition API but don't wire it up to a working speech-recognition backend —
   the mic starts (so it looks like it's listening) but recognition silently never produces a
   result. Previously errors were swallowed entirely (`rec.onerror = () => {}`), which looked
   identical to "just isn't hearing you" — the actual bug this was reported as. Now a persistent
   error gets surfaced (throttled to at most once every few seconds, since continuous mode
   auto-restarts after an error and a browser that can never succeed would otherwise spam this
   on every restart). */
function useVoiceCaddy(active, onCommand, wakeWord) {
  const recRef = useRef(null);
  const activeRef = useRef(active);
  const wakeWordRef = useRef(wakeWord);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { wakeWordRef.current = wakeWord; }, [wakeWord]); // read live so a mid-round rename takes effect without toggling voice caddy off/on
  useEffect(() => {
    if (!active) return;
    const SR = (typeof window !== "undefined") && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) return;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US";
    let lastErrorAt = 0;
    rec.onresult = (e) => {
      const transcript = e.results[e.results.length - 1][0].transcript;
      if (!heardWakeWord(transcript, wakeWordRef.current)) return;
      if (heardRecordShotCommand(transcript)) { onCommand("recordShot", null, transcript); return; }
      const club = matchClubFromSpeech(transcript);
      if (club) { onCommand("club", club, transcript); return; }
      onCommand("unmatched", null, transcript);
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return; // routine, not worth surfacing
      const now = Date.now();
      if (now - lastErrorAt < 8000) return; // throttle — continuous mode retries fast on a hard failure
      lastErrorAt = now;
      onCommand("error", e.error, "");
    };
    rec.onend = () => { if (activeRef.current) { try { rec.start(); } catch {} } };
    recRef.current = rec;
    try { rec.start(); } catch {}
    return () => { try { rec.onend = null; rec.stop(); } catch {} };
  }, [active]);
}
function voiceSupported() {
  return typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/* ---------- automatic shot-stop detection ----------
   Heuristic: while a player carries their phone, GPS sits roughly still at the tee (or wherever
   their last shot was marked), then moves as they walk/ride toward their ball, then goes roughly
   still again once they arrive. "Moved away far enough, then stayed put for a few seconds" is
   treated as "you've probably reached your ball" and offered up as a one-tap prompt to mark a
   shot there, instead of requiring a manual "Mark drive" tap every time.
   This can only sense the phone carrier's own movement — it has no way to know when a different
   player in the group hits their shot — so it's intentionally scoped to whichever player is
   marked ⭐ "you" only. Other players' shots still get marked by hand, same as before.
   The detection logic is a pure function (shotDetectorStep) with no side effects, kept separate
   from the React hook so it can be unit tested with synthetic GPS sample sequences — genuinely
   useful here since this sandbox has no way to test against a real phone's GPS. The three
   constants below are the only tuning knobs; if real-world testing shows too many/few prompts,
   these are what to adjust first. */
const SHOT_MOVE_AWAY_YARDS = 25;  // must get at least this far from the anchor to count as "walking to the ball"
const SHOT_STOP_RADIUS_YARDS = 8; // consecutive samples must stay within this radius of each other to count as "stopped"
const SHOT_STOP_WINDOW_MS = 6000; // …for at least this many milliseconds before we treat it as arrived

function shotDetectorInit(anchor) {
  return { anchor, movedAway: false, stillSince: null, stillAt: null, fired: false, stoppedAt: null };
}

function shotDetectorStep(state, sample) {
  if (!state || !state.anchor || state.fired) return state;
  const distFromAnchor = haversineYards(state.anchor.lat, state.anchor.lon, sample.lat, sample.lon);
  if (distFromAnchor == null) return state;

  if (!state.movedAway) {
    if (distFromAnchor >= SHOT_MOVE_AWAY_YARDS) {
      return { ...state, movedAway: true, stillSince: sample.t, stillAt: sample };
    }
    return state;
  }

  if (!state.stillAt) return { ...state, stillSince: sample.t, stillAt: sample };
  const distFromStill = haversineYards(state.stillAt.lat, state.stillAt.lon, sample.lat, sample.lon);
  if (distFromStill != null && distFromStill > SHOT_STOP_RADIUS_YARDS) {
    // still moving — restart the "have we stopped" window from this new spot
    return { ...state, stillSince: sample.t, stillAt: sample };
  }
  if (sample.t - state.stillSince >= SHOT_STOP_WINDOW_MS) {
    return { ...state, fired: true, stoppedAt: { lat: sample.lat, lon: sample.lon } };
  }
  return state;
}

/* thin React wrapper around the pure reducer above — feeds live GPS samples in, exposes
   whether a "stopped after moving" event has fired, and a reset() to start watching again
   from a new anchor point (called once a shot is marked, or the tracked hole changes). */
function useShotStopDetector(active, livePos, anchor) {
  const anchorKey = anchor ? `${anchor.lat.toFixed(6)},${anchor.lon.toFixed(6)}` : null;
  const [state, setState] = useState(() => shotDetectorInit(anchor));
  const lastAnchorKeyRef = useRef(anchorKey);
  useEffect(() => {
    if (anchorKey !== lastAnchorKeyRef.current) {
      lastAnchorKeyRef.current = anchorKey;
      setState(shotDetectorInit(anchor));
    }
  }, [anchorKey]);
  useEffect(() => {
    if (!active || !livePos || !anchor) return;
    setState((prev) => shotDetectorStep(prev, { lat: livePos.lat, lon: livePos.lon, t: Date.now() }));
  }, [active, livePos?.lat, livePos?.lon, anchor]);
  function reset() { lastAnchorKeyRef.current = anchorKey; setState(shotDetectorInit(anchor)); }
  return { fired: !!state.fired, stoppedAt: state.stoppedAt, reset };
}

/* localStorage key for the round currently being scored — persisted continuously so an
   accidental tab/app close doesn't lose an in-progress round (only while actively scoring;
   the setup screen and finished rounds never persist here). */
const ACTIVE_ROUND_KEY = "golf:activeRound";

/* local cache of Overpass hole lookups, keyed by the OSM place's stable id — once a course's
   hole data has been fetched successfully (from any browser tab, ever), re-selecting it in a
   search is instant and needs no network call at all. Genuinely-empty results are cached too
   (so an unmapped course doesn't get re-queried every time), but real failures never are. */
function osmCacheKey(candidate) {
  return candidate.osmType && candidate.osmId != null ? `${candidate.osmType}:${candidate.osmId}` : `latlon:${candidate.lat},${candidate.lon}`;
}
function loadOSMCache() { return loadKey("golf:osmHoleCache", {}); }
function saveOSMCache(cache) { saveKey("golf:osmHoleCache", cache); }

/* OpenStreetMap: Nominatim for course search, Overpass for hole geometry/par/yardage.
   Both calls go through this app's own /api/* serverless functions (see api/osm-search.js and
   api/osm-holes.js) rather than hitting nominatim.openstreetmap.org / overpass-api.de directly
   from the browser. Reason: browser JS can never set a custom User-Agent header (a hard browser
   restriction), and unidentified requests from generic *.vercel.app/*.netlify.app domains are
   known to get rate-limited/blocked by these services' anti-abuse systems more aggressively than
   an identified server-side client. The serverless functions send a real User-Agent and make
   these same-origin requests as far as the browser is concerned. */
async function searchOSMCourses(query) {
  const url = `/api/osm-search?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, 15000);
  if (!res.ok) throw new Error("Course search failed");
  const data = await res.json();
  return data.map((d) => ({
    osmType: d.osm_type,
    osmId: d.osm_id,
    name: (d.display_name || "").split(",")[0],
    displayName: d.display_name,
    lat: Number(d.lat),
    lon: Number(d.lon),
    boundingbox: d.boundingbox ? d.boundingbox.map(Number) : null, // [south, north, west, east]
  }));
}

/* "Find courses near me" — Overpass direct geographic search (leisure=golf_course within a
   radius), as an alternative to searching by name. Returns candidates in the same shape
   searchOSMCourses does (including a boundingbox), so callers can feed a result straight into
   the existing pickOSMResult() flow — that's what actually fetches + caches the hole-by-hole
   data for later use, exactly like a name-search result does. */
async function searchOSMNearby(lat, lon, radiusMeters) {
  const url = `/api/osm-nearby?lat=${lat}&lon=${lon}&radius=${radiusMeters}`;
  const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, 20000);
  if (!res.ok) throw new Error("Nearby course search failed");
  const data = await res.json();
  const elements = (data && data.elements) || [];
  return elements
    .map((el) => {
      const elLat = el.lat ?? el.center?.lat;
      const elLon = el.lon ?? el.center?.lon;
      if (elLat == null || elLon == null) return null;
      const name = (el.tags && el.tags.name) || "Unnamed golf course";
      // Overpass's `out center;` gives a single point, not a real bounding box — golf courses
      // are rarely more than ~3km across, so a generous fixed pad around the center comfortably
      // covers the whole course for the subsequent hole-by-hole lookup.
      const latPad = 0.02;
      const lonPad = 0.02 / Math.max(Math.cos((elLat * Math.PI) / 180), 0.15);
      return {
        osmType: el.type,
        osmId: el.id,
        name,
        displayName: name,
        lat: elLat,
        lon: elLon,
        distanceMi: haversine(lat, lon, elLat, elLon),
        boundingbox: [elLat - latPad, elLat + latPad, elLon - lonPad, elLon + lonPad],
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceMi - b.distanceMi)
    .slice(0, 20);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function parseOSMHoleElements(data) {
  return (data.elements || [])
    .map((el) => {
      const tags = el.tags || {};
      const geom = el.geometry || [];
      let meters = 0;
      for (let i = 1; i < geom.length; i++) meters += haversineMeters(geom[i - 1].lat, geom[i - 1].lon, geom[i].lat, geom[i].lon);
      const tee = geom[0], green = geom[geom.length - 1];
      return {
        number: tags.ref ? Number(tags.ref) : null,
        par: tags.par ? Number(tags.par) : null,
        strokeIndex: tags.handicap ? Number(tags.handicap) : null,
        yardageMeters: meters ? Math.round(meters) : null,
        teeLat: tee?.lat ?? null,
        teeLon: tee?.lon ?? null,
        greenLat: green?.lat ?? null,
        greenLon: green?.lon ?? null,
      };
    })
    .filter((h) => h.number != null && !isNaN(h.number))
    .sort((a, b) => a.number - b.number);
}

/* throws (rather than silently returning []) when the lookup fails, so the caller can
   tell "this course genuinely has no mapped holes" apart from "the service is down/busy".
   The mirror-fallback logic now lives server-side in api/osm-holes.js — this just calls that
   one same-origin endpoint. */
async function fetchOSMHoles(boundingbox) {
  if (!boundingbox) return [];
  const [south, north, west, east] = boundingbox;
  const url = `/api/osm-holes?south=${south}&north=${north}&west=${west}&east=${east}`;
  try {
    const res = await fetchWithTimeout(url, {}, 20000);
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = body && body.error ? ` (${body.error})` : "";
      } catch {}
      throw new Error(`Hole lookup failed${detail || `: ${res.status}`}`);
    }
    const data = await res.json();
    return parseOSMHoleElements(data);
  } catch (e) {
    const err = new Error("Hole lookup failed");
    err.cause = e;
    throw err;
  }
}

const COUNT_TABLE = { 3: 1, 4: 1, 5: 1, 6: 2, 7: 2, 8: 2, 9: 3, 10: 3, 11: 3, 12: 4, 13: 4, 14: 4, 15: 5, 16: 5, 17: 6, 18: 6, 19: 7 };
function countToUse(n) {
  if (n < 3) return 0;
  if (n >= 20) return 8;
  return COUNT_TABLE[n];
}
function computeHandicapIndex(differentials) {
  const n = differentials.length;
  const c = countToUse(n);
  if (c === 0) return null;
  const sorted = [...differentials].sort((a, b) => a - b);
  const lowest = sorted.slice(0, c);
  const avg = lowest.reduce((s, v) => s + v, 0) / lowest.length;
  return Math.round(avg * 0.96 * 10) / 10;
}
function courseHandicap(handicapIndex, slope, rating, par) {
  if (handicapIndex == null) return 0;
  const s = slope || 113;
  const r = rating != null ? rating : par;
  return Math.round(handicapIndex * (s / 113) + (r - par));
}
function strokesOnHole(ch, strokeIndex) {
  if (!strokeIndex) return 0;
  const base = Math.floor(ch / 18);
  const extra = (ch % 18) >= strokeIndex ? 1 : 0;
  return Math.max(0, base + extra);
}
function parTotal(course) {
  return course.holes.reduce((s, h) => s + (Number(h.par) || 0), 0);
}

/* distances are always stored in yards; convert only for display/entry */
const ydToM = (yd) => (yd == null || yd === "" ? "" : Math.round(Number(yd) * 0.9144));
const mToYd = (m) => (m == null || m === "" ? "" : Math.round(Number(m) / 0.9144));
function displayDistance(yardsValue, unit) {
  if (yardsValue == null || yardsValue === "") return "";
  return unit === "m" ? ydToM(yardsValue) : yardsValue;
}
function toYardsFromInput(inputValue, unit) {
  if (inputValue === "") return "";
  return unit === "m" ? mToYd(inputValue) : Number(inputValue);
}

/* shot-shape stats */
function computeShotStats(shotStats) {
  const list = shotStats || [];
  const par45 = list.filter((s) => s.par !== 3);
  const par3 = list.filter((s) => s.par === 3);
  const pct = (arr, shape) => (arr.length ? Math.round((100 * arr.filter((s) => s.shape === shape).length) / arr.length) : null);
  return {
    par45Count: par45.length,
    fairwayPct: pct(par45, "fairway"),
    leftPct: pct(par45, "left"),
    rightPct: pct(par45, "right"),
    par3Count: par3.length,
    girPct: pct(par3, "green"),
    par3LeftPct: pct(par3, "left"),
    par3RightPct: pct(par3, "right"),
  };
}

/* stroke-play round stats for one player: FIR/GIR/putts/drive shape breakdown */
function computeRoundStats(round, pid, courseHoles) {
  const holes = round.scores[pid]?.holes || {};
  let totalPutts = 0, puttsCount = 0;
  let firHit = 0, firAttempts = 0;
  let girHit = 0, girAttempts = 0;
  const shapeCounts = { left: 0, fairway: 0, right: 0 };
  courseHoles.forEach((h) => {
    const cell = holes[h.number];
    if (!cell) return;
    const putts = Number(cell.putts);
    if (cell.putts !== "" && cell.putts != null && !isNaN(putts)) { totalPutts += putts; puttsCount += 1; }
    if (h.par !== 3 && cell.shape) {
      firAttempts += 1;
      if (cell.shape === "fairway") firHit += 1;
      shapeCounts[cell.shape] = (shapeCounts[cell.shape] || 0) + 1;
    }
    const gross = Number(cell.gross);
    if (cell.gross !== "" && cell.gross != null && !isNaN(gross) && cell.putts !== "" && cell.putts != null && !isNaN(putts)) {
      girAttempts += 1;
      if (gross - putts <= h.par - 2) girHit += 1;
    }
  });
  return {
    totalPutts, puttsCount,
    fir: firAttempts ? Math.round((100 * firHit) / firAttempts) : null, firHit, firAttempts,
    gir: girAttempts ? Math.round((100 * girHit) / girAttempts) : null, girHit, girAttempts,
    shapeCounts,
  };
}
const SHAPE_COLOR = { left: C.flag, right: C.brass, fairway: C.turf, green: C.turf };

function ScoreBadge({ gross, par }) {
  if (gross == null || gross === "")
    return <span style={{ color: C.line }}>–</span>;
  const diff = gross - par;
  let border = "1px solid transparent";
  let radius = "4px";
  if (diff <= -2) { border = `2px double ${C.flag}`; radius = "50%"; }
  else if (diff === -1) { border = `2px solid ${C.flag}`; radius = "50%"; }
  else if (diff === 1) { border = `2px solid ${C.turf}`; radius = "3px"; }
  else if (diff >= 2) { border = `2px double ${C.turf}`; radius = "3px"; }
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 32, height: 32, border, borderRadius: radius, fontFamily: mono,
        fontWeight: 600, color: C.ink, fontSize: 15,
      }}
    >
      {gross}
    </span>
  );
}

function ShapeSelector({ par, value, onChange }) {
  const opts = par === 3 ? [["left", "L"], ["green", "GR"], ["right", "R"]] : [["left", "L"], ["fairway", "F"], ["right", "R"]];
  return (
    <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
      {opts.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(value === v ? null : v)}
          style={{
            fontSize: 12, padding: "5px 8px", fontFamily: sans, fontWeight: 700, borderRadius: 4, cursor: "pointer",
            border: `1px solid ${value === v ? C.fairway : C.line}`,
            background: value === v ? C.fairway : C.white,
            color: value === v ? C.white : C.turf,
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/* ---------- drive-distance map modal (leaflet) ---------- */
const teeIcon = new L.DivIcon({ className: "", html: `<div style="width:14px;height:14px;border-radius:50%;background:#FBF9F2;border:3px solid ${C.fairway};box-shadow:0 0 0 1px ${C.fairway};"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
const greenIcon = new L.DivIcon({ className: "", html: `<div style="width:16px;height:16px;border-radius:50%;background:${C.turf};border:2px solid #FBF9F2;"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
const landingIcon = new L.DivIcon({ className: "", html: `<div style="width:16px;height:16px;border-radius:50%;background:${C.flag};border:2px solid #FBF9F2;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });

function MapClickCapture({ onPick }) {
  useMapEvents({ click(e) { onPick(e.latlng); } });
  return null;
}

function DriveMapModal({ hole, label, shotLabel, fromLat, fromLon, initialPos, distanceUnit, onSave, onCancel }) {
  const [pos, setPos] = useState(initialPos || null);
  const shotWord = shotLabel || "drive";
  /* "from" point to measure this shot's own distance from — the tee for the first shot on a
     hole, or wherever the previous shot was marked for anything after that (passed in by the
     caller via fromLat/fromLon; falls back to the tee for backward compatibility). */
  const anchorLat = fromLat ?? hole.teeLat;
  const anchorLon = fromLon ?? hole.teeLon;
  const hasBoth = anchorLat != null && hole.greenLat != null;
  const center = hasBoth
    ? [(anchorLat + hole.greenLat) / 2, (anchorLon + hole.greenLon) / 2]
    : [anchorLat ?? hole.greenLat, anchorLon ?? hole.greenLon];
  const shotYards = pos && anchorLat != null ? haversineYards(anchorLat, anchorLon, pos.lat, pos.lng) : null;
  const remainYards = pos && hole.greenLat != null ? haversineYards(pos.lat, pos.lng, hole.greenLat, hole.greenLon) : null;
  const unitLabel = distanceUnit === "m" ? "m" : "yd";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(20,20,16,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 14 }}>
      <div style={{ background: C.paper, borderRadius: 10, padding: 16, width: "100%", maxWidth: 480, maxHeight: "92vh", overflow: "auto" }}>
        <div style={{ fontFamily: serif, fontSize: 16, color: C.fairway, marginBottom: 4 }}>Mark {label}'s {shotWord}</div>
        <div style={{ fontFamily: sans, fontSize: 12, color: C.turf, marginBottom: 10 }}>
          {initialPos ? "Pin dropped at your current GPS location — tap the map to adjust it, then save." : "Tap the map where the ball landed."}
        </div>
        <div style={{ height: 320, borderRadius: 6, overflow: "hidden", border: `1px solid ${C.line}` }}>
          <MapContainer center={center} zoom={17} style={{ height: "100%", width: "100%" }}>
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
            {anchorLat != null && <Marker position={[anchorLat, anchorLon]} icon={teeIcon} />}
            {hole.greenLat != null && <Marker position={[hole.greenLat, hole.greenLon]} icon={greenIcon} />}
            {pos && <Marker position={pos} icon={landingIcon} />}
            <MapClickCapture onPick={setPos} />
          </MapContainer>
        </div>
        <div style={{ fontFamily: sans, fontSize: 11, color: C.turf, margin: "8px 0" }}>
          <span style={{ color: C.fairway, fontWeight: 700 }}>◎</span> {fromLat != null ? "Previous shot" : "Tee"} &nbsp;·&nbsp; <span style={{ color: C.turf, fontWeight: 700 }}>●</span> Green &nbsp;·&nbsp; <span style={{ color: C.flag, fontWeight: 700 }}>●</span> Where you tapped
        </div>
        {pos ? (
          <div style={{ fontFamily: mono, fontSize: 14, color: C.ink, marginBottom: 10 }}>
            {shotYards != null && <>This shot: <b>{Math.round(displayDistance(shotYards, distanceUnit))} {unitLabel}</b></>}
            {shotYards != null && remainYards != null && " · "}
            {remainYards != null && <>Remaining to green: <b>{Math.round(displayDistance(remainYards, distanceUnit))} {unitLabel}</b></>}
          </div>
        ) : (
          <div style={{ fontFamily: sans, fontSize: 12, color: C.turf, marginBottom: 10 }}>No spot marked yet.</div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button style={btnGhost} onClick={onCancel}>Cancel</button>
          <button style={btnPrimary} disabled={!pos} onClick={() => onSave(shotYards != null ? Math.round(shotYards) : null, pos.lat, pos.lng, remainYards)}>Save</button>
        </div>
      </div>
    </div>
  );
}

function VoiceCaddyButton({ voiceOn, setVoiceOn, voiceMsg, mePlayer, wakeWord }) {
  const supported = voiceSupported();
  const name = (wakeWord || "").trim() || "Gaddy";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
      <button
        title={!supported ? "Voice control needs a browser with speech recognition (Chrome works best)" : !mePlayer ? "Mark a player as ⭐ you in the Players tab first" : voiceOn ? `Listening for "Hey ${name}, I'm using a..." or "Hey ${name}, record shot"` : "Turn on voice caddy"}
        disabled={!supported}
        onClick={() => setVoiceOn(!voiceOn)}
        style={{
          ...btnGhost, fontSize: 12, padding: "7px 12px",
          background: voiceOn ? C.flag : C.white, color: voiceOn ? C.white : C.fairway, borderColor: voiceOn ? C.flag : C.fairway,
          opacity: supported ? 1 : 0.5, cursor: supported ? "pointer" : "not-allowed",
        }}
      >
        {voiceOn ? "🎙️ Listening…" : "🎙️ Voice caddy"}
      </button>
      {voiceOn && voiceMsg && <div style={{ fontFamily: sans, fontSize: 11, color: C.turf, maxWidth: 220, textAlign: "right" }}>{voiceMsg}</div>}
    </div>
  );
}

/* Floating banner offered when the auto shot-stop detector thinks you've walked to your ball
   and stopped (see shotDetectorStep above) — a one-tap alternative to hunting for the manual
   "Mark drive"/"Mark shot" button on your own scorecard row while you're standing on the course. */
function ShotStopPrompt({ hole, onMark, onDismiss }) {
  return (
    <div
      style={{
        position: "fixed", left: 14, right: 14, bottom: 14, zIndex: 900, maxWidth: 480, margin: "0 auto",
        background: C.fairway, color: C.white, borderRadius: 10, padding: "12px 14px",
        boxShadow: "0 4px 18px rgba(0,0,0,0.35)", display: "flex", justifyContent: "space-between",
        alignItems: "center", gap: 10, flexWrap: "wrap",
      }}
    >
      <div style={{ fontFamily: sans, fontSize: 13 }}>
        Looks like you've stopped on hole {hole.number} — mark your shot here?
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button onClick={onDismiss} style={{ ...btnGhost, borderColor: "rgba(251,249,242,0.6)", color: C.white, fontSize: 12, padding: "7px 12px" }}>Not now</button>
        <button onClick={onMark} style={{ ...btnPrimary, background: C.brass, color: C.fairwayDark, fontSize: 12, padding: "7px 14px" }}>📍 Mark it</button>
      </div>
    </div>
  );
}

function Tab({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, minWidth: 0, fontFamily: serif, fontSize: 13, letterSpacing: "0.02em", textTransform: "uppercase",
        padding: "11px 4px", background: "transparent", border: "none", cursor: "pointer",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        color: active ? C.white : "rgba(251,249,242,0.55)",
        borderBottom: active ? `2px solid ${C.brass}` : "2px solid transparent",
      }}
    >
      {label}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: C.turf, marginBottom: 5, fontFamily: sans }}>
        {label}
      </div>
      {children}
    </label>
  );
}
const inputStyle = {
  width: "100%", padding: "11px 12px", border: `1px solid ${C.line}`, borderRadius: 5,
  background: C.white, fontFamily: sans, fontSize: 16, color: C.ink, boxSizing: "border-box",
};
/* <select> elements render with their own native height/padding on many mobile browsers
   even with identical CSS to a text input — this normalizes them so dropdowns line up
   with neighboring text fields instead of looking shorter/misaligned */
const selectStyle = {
  ...inputStyle,
  appearance: "none", WebkitAppearance: "none", MozAppearance: "none",
  height: 44, lineHeight: "20px",
  backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M0 0l5 6 5-6z' fill='%234b5d4a'/></svg>\")",
  backgroundRepeat: "no-repeat", backgroundPosition: "right 12px center", paddingRight: 30,
};
const btnPrimary = {
  background: C.fairway, color: C.white, border: "none", borderRadius: 6, padding: "13px 20px",
  fontFamily: sans, fontSize: 16, fontWeight: 600, cursor: "pointer",
};
const btnGhost = {
  background: "transparent", color: C.fairway, border: `1px solid ${C.fairway}`, borderRadius: 6,
  padding: "10px 16px", fontFamily: sans, fontSize: 14, fontWeight: 600, cursor: "pointer",
};
const btnDanger = {
  background: "transparent", color: C.flag, border: `1px solid ${C.flag}`, borderRadius: 6,
  padding: "8px 12px", fontFamily: sans, fontSize: 13, fontWeight: 600, cursor: "pointer",
};
const thStyle = { textAlign: "left", padding: "9px 12px", borderBottom: `1px solid ${C.line}`, fontSize: 12, textTransform: "uppercase", color: C.turf };
const tdStyle = { padding: "9px 12px", borderBottom: `1px solid ${C.line}`, fontSize: 14 };
const cardStyle = { background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, padding: "16px 18px" };
const emptyStyle = { fontFamily: sans, fontSize: 15, color: C.turf, padding: "24px 0", textAlign: "center" };

/* ================= COURSES TAB ================= */
function CoursesTab({ courses, setCourses, location, requestLocation, distanceUnit }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [numHoles, setNumHoles] = useState(18);
  const [rating, setRating] = useState("");
  const [slope, setSlope] = useState("");
  const [manualLat, setManualLat] = useState("");
  const [manualLon, setManualLon] = useState("");
  const [holes, setHoles] = useState(
    Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, yardage: "", strokeIndex: "", teeLat: null, teeLon: null, greenLat: null, greenLon: null }))
  );
  const [osmQuery, setOsmQuery] = useState("");
  const [osmResults, setOsmResults] = useState([]);
  const [osmLoading, setOsmLoading] = useState(false);
  const [osmStatus, setOsmStatus] = useState("");
  const [osmFailed, setOsmFailed] = useState(false);
  const [lastOSMCandidate, setLastOSMCandidate] = useState(null);
  const [osmCache, setOsmCache] = useState(() => loadOSMCache());
  const [osmFromCache, setOsmFromCache] = useState(false);
  const [showManualHelpers, setShowManualHelpers] = useState(false);
  const [nearbyLoading, setNearbyLoading] = useState(false);

  function cacheOSMHoles(key, holes) {
    const entry = { holes, cachedAt: Date.now() };
    const next = { ...osmCache, [key]: entry };
    setOsmCache(next);
    saveOSMCache(next);
  }

  const sorted = useMemo(() => {
    if (!location) return courses;
    return [...courses].sort((a, b) => {
      const da = a.lat != null ? haversine(location.lat, location.lon, a.lat, a.lon) : Infinity;
      const db = b.lat != null ? haversine(location.lat, location.lon, b.lat, b.lon) : Infinity;
      return da - db;
    });
  }, [courses, location]);

  async function searchOSM() {
    const q = osmQuery.trim() || name.trim();
    if (!q) return;
    setOsmLoading(true); setOsmStatus(""); setOsmResults([]); setOsmFailed(false);
    try {
      const results = await searchOSMCourses(q);
      setOsmResults(results);
      if (results.length === 0) setOsmStatus("No matches on OpenStreetMap — try adding a city, or set the pin manually below.");
    } catch (e) {
      setOsmStatus("Couldn't reach OpenStreetMap right now — set the pin manually below.");
    }
    setOsmLoading(false);
  }

  const NEARBY_RADIUS_METERS = 40000; // ~25 miles

  async function findNearby() {
    let loc = location;
    if (!loc) {
      loc = await requestLocation();
      if (!loc) {
        setOsmStatus("Couldn't get your location — check location permissions and try again, or search by name instead.");
        return;
      }
    }
    setNearbyLoading(true); setOsmStatus(""); setOsmResults([]); setOsmFailed(false);
    try {
      const results = await searchOSMNearby(loc.lat, loc.lon, NEARBY_RADIUS_METERS);
      setOsmResults(results);
      if (results.length === 0) {
        setOsmStatus("No golf courses found on OpenStreetMap within 25 miles of you — try searching by name instead.");
      }
    } catch (e) {
      setOsmStatus("Couldn't reach OpenStreetMap right now — try again in a moment, or search by name.");
    }
    setNearbyLoading(false);
  }

  async function pickOSMResult(candidate) {
    setOsmLoading(true);
    setOsmFailed(false);
    setName(candidate.name);
    setManualLat(String(candidate.lat));
    setManualLon(String(candidate.lon));
    setOsmResults([]);
    setLastOSMCandidate(candidate);

    const key = osmCacheKey(candidate);
    const cached = osmCache[key];
    if (cached) {
      applyOSMHoles(cached.holes, cached.cachedAt);
      setOsmLoading(false);
      return;
    }
    try {
      const osmHoles = await fetchOSMHoles(candidate.boundingbox);
      cacheOSMHoles(key, osmHoles); // cache successes AND genuine zero-result answers — never cache a failure
      applyOSMHoles(osmHoles, null);
    } catch (e) {
      // fetchOSMHoles throws only when every Overpass mirror failed (timeout/rate-limit/network) —
      // that's a temporary service problem, not "this course has no holes", so say so and offer a retry
      setOsmFailed(true);
      setOsmStatus("Location set, but OpenStreetMap's hole-data service (Overpass) is currently rejecting requests — it's a known, widespread issue with the free public service, not specific to this device or how the app is hosted. Try the retry button below in a minute (it tries 3 different mirrors), or enter holes manually.");
    }
    setOsmLoading(false);
  }

  function applyOSMHoles(osmHoles, cachedAt) {
    setOsmFromCache(cachedAt != null);
    const cacheNote = cachedAt != null ? ` (loaded from local cache, last checked ${new Date(cachedAt).toLocaleDateString()} — tap Refresh below to re-check OpenStreetMap)` : "";
    if (osmHoles.length > 0) {
      const n = osmHoles.length <= 9 ? 9 : 18;
      const total = Math.max(n, osmHoles.length);
      const newHoles = Array.from({ length: total }, (_, i) => {
        const num = i + 1;
        const found = osmHoles.find((h) => h.number === num);
        return {
          number: num,
          par: found?.par || 4,
          yardage: found?.yardageMeters ? Math.round(found.yardageMeters / 0.9144) : "",
          strokeIndex: found?.strokeIndex || "",
          teeLat: found?.teeLat ?? null,
          teeLon: found?.teeLon ?? null,
          greenLat: found?.greenLat ?? null,
          greenLon: found?.greenLon ?? null,
        };
      });
      const gpsCount = osmHoles.filter((h) => h.greenLat != null).length;
      setNumHoles(total);
      setHoles(newHoles);
      setOsmStatus(`Found ${osmHoles.length} hole${osmHoles.length !== 1 ? "s" : ""} mapped on OpenStreetMap (${gpsCount} with tee/green GPS for live distance)${cacheNote} — review par/distance below before saving.`);
    } else {
      setOsmStatus(`Location set from OpenStreetMap, but no hole-by-hole data is mapped for this course yet${cacheNote} — enter holes manually below.`);
    }
  }

  /* always bypasses the cache — used both to retry after a failure and to force-refresh a
     cached answer (e.g. OpenStreetMap volunteers may have added hole data since it was cached) */
  async function refreshOSMHoles() {
    if (!lastOSMCandidate) return;
    setOsmLoading(true);
    setOsmFailed(false);
    setOsmFromCache(false);
    setOsmStatus("Checking OpenStreetMap…");
    try {
      const osmHoles = await fetchOSMHoles(lastOSMCandidate.boundingbox);
      cacheOSMHoles(osmCacheKey(lastOSMCandidate), osmHoles);
      applyOSMHoles(osmHoles, null);
    } catch (e) {
      setOsmFailed(true);
      setOsmStatus("Still rejecting requests across all 3 mirrors — the public Overpass service is under heavy load right now (a known, current issue, unrelated to this app). The course location is saved either way; enter holes manually below, or try again in a few minutes.");
    }
    setOsmLoading(false);
  }

  function resetForm() {
    setName(""); setNumHoles(18); setRating(""); setSlope(""); setManualLat(""); setManualLon("");
    setHoles(Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, yardage: "", strokeIndex: "", teeLat: null, teeLon: null, greenLat: null, greenLon: null })));
    setOsmQuery(""); setOsmResults([]); setOsmStatus(""); setOsmFailed(false); setLastOSMCandidate(null); setOsmFromCache(false);
    setAdding(false);
  }
  function updateHoleCount(n) {
    setNumHoles(n);
    setHoles(Array.from({ length: n }, (_, i) => holes[i] || { number: i + 1, par: 4, yardage: "", strokeIndex: "", teeLat: null, teeLon: null, greenLat: null, greenLon: null }));
  }
  function updateHole(i, field, val) {
    const next = [...holes];
    next[i] = { ...next[i], [field]: val };
    setHoles(next);
  }
  function autoFillStrokeIndex() {
    const next = holes.map((h, i) => ({ ...h, strokeIndex: (i % 18) + 1 }));
    setHoles(next);
  }
  async function useMyLocation() {
    const loc = await requestLocation();
    if (loc) { setManualLat(String(loc.lat)); setManualLon(String(loc.lon)); }
  }
  function openInMaps() {
    const q = encodeURIComponent(name.trim() || "golf course");
    window.open(`https://www.google.com/maps/search/?api=1&query=${q}`, "_blank", "noopener,noreferrer");
  }
  function saveCourse() {
    if (!name.trim()) return;
    const course = {
      id: uid(), name: name.trim(),
      lat: manualLat !== "" ? Number(manualLat) : null,
      lon: manualLon !== "" ? Number(manualLon) : null,
      rating: rating ? Number(rating) : null, slope: slope ? Number(slope) : null,
      holes: holes.map((h) => ({
        number: h.number, par: Number(h.par) || 4, yardage: h.yardage ? Number(h.yardage) : null, strokeIndex: h.strokeIndex ? Number(h.strokeIndex) : null,
        teeLat: h.teeLat ?? null, teeLon: h.teeLon ?? null, greenLat: h.greenLat ?? null, greenLon: h.greenLon ?? null,
      })),
    };
    setCourses([...courses, course]);
    resetForm();
  }
  function deleteCourse(id) {
    setCourses(courses.filter((c) => c.id !== id));
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontFamily: sans, fontSize: 13, color: C.turf }}>
          {location ? "Sorted by distance from you" : "Enable location to sort by distance"}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={btnGhost} onClick={requestLocation}>Use my location</button>
          <button style={btnPrimary} onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "+ Add course"}</button>
        </div>
      </div>

      {adding && (
        <div style={{ background: C.paper2, border: `1px solid ${C.line}`, borderRadius: 8, padding: 16, marginBottom: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 12 }}>
            <Field label="Course name"><input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Holes">
              <select style={selectStyle} value={numHoles} onChange={(e) => updateHoleCount(Number(e.target.value))}>
                <option value={9}>9</option>
                <option value={18}>18</option>
              </select>
            </Field>
            <Field label="Rating (optional)"><input style={inputStyle} value={rating} onChange={(e) => setRating(e.target.value)} placeholder="e.g. 71.2" /></Field>
            <Field label="Slope (optional)"><input style={inputStyle} value={slope} onChange={(e) => setSlope(e.target.value)} placeholder="e.g. 128" /></Field>
          </div>

          <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 6, padding: 12, marginBottom: 14 }}>
            <div style={{ fontFamily: sans, fontSize: 12, color: C.turf, marginBottom: 8 }}>
              Search OpenStreetMap — pulls the course location, and where it's been mapped in detail, real hole-by-hole par, stroke index and distance.
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input style={inputStyle} placeholder="Course name + city" value={osmQuery} onChange={(e) => setOsmQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && searchOSM()} />
              <button style={{ ...btnGhost, flexShrink: 0 }} onClick={searchOSM} disabled={osmLoading || nearbyLoading}>{osmLoading ? "…" : "Search"}</button>
            </div>
            <button style={{ ...btnGhost, fontSize: 12, padding: "8px 12px", width: "100%", boxSizing: "border-box", marginBottom: 8 }} onClick={findNearby} disabled={osmLoading || nearbyLoading}>
              {nearbyLoading ? "Finding courses near you…" : "📍 Find courses near me"}
            </button>
            {osmResults.length > 0 && (
              <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
                {osmResults.map((r, i) => {
                  const cached = osmCache[osmCacheKey(r)];
                  return (
                    <div key={i} onClick={() => pickOSMResult(r)} style={{ ...cardStyle, cursor: "pointer", padding: "8px 12px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                        <div style={{ fontFamily: sans, fontWeight: 700, fontSize: 13, color: C.fairway }}>{r.name}</div>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexShrink: 0 }}>
                          {r.distanceMi != null && <span style={{ fontSize: 11, color: C.turf, fontFamily: sans }}>{r.distanceMi.toFixed(1)} mi</span>}
                          {cached && <span title={`Cached ${new Date(cached.cachedAt).toLocaleDateString()} — loads instantly, no network needed`} style={{ fontSize: 11, color: C.turf, fontFamily: sans }}>🗄 cached</span>}
                        </div>
                      </div>
                      <div style={{ fontFamily: sans, fontSize: 11, color: C.turf }}>{r.displayName}</div>
                    </div>
                  );
                })}
              </div>
            )}
            {osmStatus && <div style={{ fontFamily: sans, fontSize: 12, color: C.turf }}>{osmStatus}</div>}
            {(osmFailed || osmFromCache) && lastOSMCandidate && (
              <button style={{ ...btnGhost, fontSize: 12, padding: "6px 12px", marginTop: 8 }} onClick={refreshOSMHoles} disabled={osmLoading}>
                {osmLoading ? "Checking…" : osmFailed ? "↻ Retry hole lookup" : "↻ Refresh from OpenStreetMap"}
              </button>
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: showManualHelpers ? 8 : 4 }}>
            <div style={{ fontFamily: sans, fontSize: 12, color: C.turf }}>
              Or set the pin manually: enter latitude/longitude below.
            </div>
            <button
              title="More options — search Google Maps or use your current location"
              onClick={() => setShowManualHelpers(!showManualHelpers)}
              style={{
                flexShrink: 0, background: "transparent", border: `1px solid ${C.line}`, borderRadius: 5,
                width: 28, height: 28, cursor: "pointer", color: C.turf, fontSize: 16, lineHeight: "26px", padding: 0,
              }}
            >
              ⋯
            </button>
          </div>
          {showManualHelpers && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 10, flexWrap: "wrap" }}>
              <button style={{ ...btnGhost, padding: "8px 12px", fontSize: 12 }} onClick={openInMaps}>🔍 Search "{name.trim() || "course name"}" on Google Maps ↗</button>
              <button style={{ ...btnGhost, padding: "8px 12px", fontSize: 12 }} onClick={useMyLocation}>Use my current location instead</button>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 10 }}>
            <Field label="Latitude">
              <input style={inputStyle} type="number" step="any" placeholder="e.g. 33.5031" value={manualLat} onChange={(e) => setManualLat(e.target.value)} />
            </Field>
            <Field label="Longitude">
              <input style={inputStyle} type="number" step="any" placeholder="e.g. -86.8085" value={manualLon} onChange={(e) => setManualLon(e.target.value)} />
            </Field>
          </div>

          <div style={{ maxHeight: 320, overflowY: "auto", border: `1px solid ${C.line}`, borderRadius: 6 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: mono, fontSize: 13 }}>
              <thead>
                <tr style={{ background: C.paper, position: "sticky", top: 0 }}>
                  <th style={thStyle}>Hole</th><th style={thStyle}>Par</th><th style={thStyle}>Distance ({distanceUnit === "m" ? "m" : "yd"})</th><th style={thStyle}>Stroke Idx</th><th style={thStyle}>GPS</th>
                </tr>
              </thead>
              <tbody>
                {holes.map((h, i) => (
                  <tr key={i}>
                    <td style={tdStyle}>{h.number}</td>
                    <td style={tdStyle}>
                      <select style={{ ...inputStyle, padding: "4px 6px" }} value={h.par} onChange={(e) => updateHole(i, "par", e.target.value)}>
                        {[3, 4, 5].map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </td>
                    <td style={tdStyle}>
                      <input style={{ ...inputStyle, padding: "4px 6px" }}
                        value={displayDistance(h.yardage, distanceUnit)}
                        onChange={(e) => updateHole(i, "yardage", toYardsFromInput(e.target.value, distanceUnit))}
                        placeholder={distanceUnit === "m" ? "m" : "yds"} />
                    </td>
                    <td style={tdStyle}><input style={{ ...inputStyle, padding: "4px 6px" }} value={h.strokeIndex} onChange={(e) => updateHole(i, "strokeIndex", e.target.value)} placeholder="1-18" /></td>
                    <td style={{ ...tdStyle, textAlign: "center" }} title={h.greenLat != null ? "Tee/green GPS from OpenStreetMap — live distance & drive tracking available" : "No GPS data for this hole"}>
                      {h.greenLat != null ? "📍" : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
            <button style={{ ...btnGhost, fontSize: 12 }} onClick={autoFillStrokeIndex}>Auto-fill stroke index 1–{numHoles}</button>
            <button style={btnPrimary} onClick={saveCourse}>Save course</button>
          </div>
        </div>
      )}

      {sorted.length === 0 && !adding && (
        <div style={emptyStyle}>No courses yet. Add one to start keeping score.</div>
      )}
      <div style={{ display: "grid", gap: 10 }}>
        {sorted.map((c) => (
          <div key={c.id} style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontFamily: serif, fontSize: 17, color: C.fairway }}>{c.name}</div>
              <button style={btnDanger} onClick={() => deleteCourse(c.id)}>Remove</button>
            </div>
            <div style={{ fontFamily: sans, fontSize: 12, color: C.turf, marginTop: 4 }}>
              {c.holes.length} holes · Par {parTotal(c)}
              {c.rating ? ` · Rating ${c.rating}/${c.slope || 113}` : ""}
              {location && c.lat != null ? ` · ${haversine(location.lat, location.lon, c.lat, c.lon).toFixed(1)} mi away` : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================= PLAYERS TAB ================= */
function bagHasClub(bag, club) { return (bag || []).some((c) => c.club === club); }
function bagDistance(bag, club) { const c = (bag || []).find((c) => c.club === club); return c ? c.distanceYards : ""; }
function toggleBagClub(bag, club) {
  if (bagHasClub(bag, club)) return (bag || []).filter((c) => c.club !== club);
  return [...(bag || []), { club, distanceYards: null }];
}
function setBagDistance(bag, club, yards) {
  return (bag || []).map((c) => (c.club === club ? { ...c, distanceYards: yards } : c));
}

function GolfBagEditor({ bag, onChange, distanceUnit }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 14px" }}>
      {CLUBS.map((club) => {
        const has = bagHasClub(bag, club);
        const yards = bagDistance(bag, club);
        return (
          <div key={club} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: sans, fontSize: 13, color: C.ink, minWidth: 100, cursor: "pointer" }}>
              <input type="checkbox" checked={has} onChange={() => onChange(toggleBagClub(bag, club))} />
              {club}
            </label>
            {has && (
              <input
                type="number"
                style={{ ...inputStyle, width: 76, padding: "5px 8px" }}
                placeholder={distanceUnit === "m" ? "m" : "yds"}
                value={displayDistance(yards, distanceUnit)}
                onChange={(e) => onChange(setBagDistance(bag, club, toYardsFromInput(e.target.value, distanceUnit)))}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function PlayersTab({ players, setPlayers, distanceUnit, mePlayerId, setMePlayerId, voiceWakeWord, setVoiceWakeWord }) {
  const [name, setName] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [wakeWordDraft, setWakeWordDraft] = useState(voiceWakeWord || "");

  useEffect(() => { setWakeWordDraft(voiceWakeWord || ""); }, [voiceWakeWord]);

  function addPlayer() {
    if (!name.trim()) return;
    setPlayers([...players, { id: uid(), name: name.trim(), differentials: [], shotStats: [], bag: [] }]);
    setName("");
  }
  function deletePlayer(id) {
    setPlayers(players.filter((p) => p.id !== id));
    if (mePlayerId === id) setMePlayerId(null);
  }
  function updateBag(pid, nextBag) {
    setPlayers(players.map((p) => (p.id === pid ? { ...p, bag: nextBag } : p)));
  }
  const effectiveWakeWord = (voiceWakeWord || "").trim() || "Gaddy";

  return (
    <div>
      <div style={{ ...cardStyle, marginBottom: 18 }}>
        <div style={{ fontFamily: sans, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: C.turf, marginBottom: 6 }}>
          Voice caddy name
        </div>
        <div style={{ fontFamily: sans, fontSize: 12, color: C.turf, marginBottom: 10 }}>
          Say "Hey {effectiveWakeWord}" to trigger voice commands during a round. "Gaddy" (a play on
          "caddy") doesn't transcribe reliably for everyone — pick something your phone hears clearly,
          like your own name or "Charlie". Applies to every round on this device, for anyone using it.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            style={{ ...inputStyle, maxWidth: 220 }}
            placeholder="Gaddy"
            value={wakeWordDraft}
            onChange={(e) => setWakeWordDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setVoiceWakeWord(wakeWordDraft.trim())}
          />
          <button style={btnGhost} onClick={() => setVoiceWakeWord(wakeWordDraft.trim())}>Save</button>
          {(voiceWakeWord || "").trim() && (
            <button style={{ ...btnGhost, borderColor: C.flag, color: C.flag }} onClick={() => { setWakeWordDraft(""); setVoiceWakeWord(""); }}>
              Reset to "Gaddy"
            </button>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        <input style={inputStyle} placeholder="Player name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addPlayer()} />
        <button style={btnPrimary} onClick={addPlayer}>Add player</button>
      </div>
      {players.length === 0 && <div style={emptyStyle}>No players yet. Add yourself and your foursome.</div>}
      <div style={{ display: "grid", gap: 10 }}>
        {players.map((p) => {
          const idx = computeHandicapIndex(p.differentials.map((d) => d.value));
          const stats = computeShotStats(p.shotStats);
          const isOpen = expanded === p.id;
          return (
            <div key={p.id} style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setExpanded(isOpen ? null : p.id)}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    title={mePlayerId === p.id ? "This is you — suggested clubs & voice caddy use your bag" : "Mark as you, for club suggestions and voice caddy"}
                    onClick={(e) => { e.stopPropagation(); setMePlayerId(mePlayerId === p.id ? null : p.id); }}
                    style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 16, padding: 0, lineHeight: 1 }}
                  >
                    {mePlayerId === p.id ? "⭐" : "☆"}
                  </button>
                  <div style={{ fontFamily: serif, fontSize: 17, color: C.fairway }}>{p.name}</div>
                  {(p.bag || []).length > 0 && <span title={`${p.bag.length} clubs in bag`} style={{ fontSize: 14 }}>🎒</span>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ fontFamily: mono, fontSize: 15, color: C.ink }}>
                    {idx != null ? `HI ${idx.toFixed(1)}` : "HI —"}
                  </div>
                  <button style={btnDanger} onClick={(e) => { e.stopPropagation(); deletePlayer(p.id); }}>Remove</button>
                </div>
              </div>
              {isOpen && (
                <div style={{ marginTop: 10, borderTop: `1px solid ${C.line}`, paddingTop: 10 }}>
                  {p.differentials.length === 0 ? (
                    <div style={{ fontFamily: sans, fontSize: 13, color: C.turf, marginBottom: 12 }}>
                      No stroke-play rounds recorded yet. Handicap index needs at least 3 rounds to estimate.
                    </div>
                  ) : (
                    <>
                      <div style={{ fontFamily: sans, fontSize: 12, color: C.turf, marginBottom: 6 }}>
                        {p.differentials.length} round{p.differentials.length !== 1 ? "s" : ""} on file · using best {countToUse(p.differentials.length) || 0} differential{countToUse(p.differentials.length) === 1 ? "" : "s"}
                      </div>
                      <table style={{ width: "100%", fontFamily: mono, fontSize: 12, borderCollapse: "collapse", marginBottom: 14 }}>
                        <thead><tr><th style={thStyle}>Date</th><th style={thStyle}>Course</th><th style={thStyle}>Differential</th></tr></thead>
                        <tbody>
                          {[...p.differentials].reverse().map((d, i) => (
                            <tr key={i}><td style={tdStyle}>{d.date}</td><td style={tdStyle}>{d.courseName}</td><td style={tdStyle}>{d.value.toFixed(1)}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                  <div style={{ fontFamily: sans, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: C.turf, marginBottom: 6 }}>Shot shape</div>
                  {stats.par45Count === 0 && stats.par3Count === 0 ? (
                    <div style={{ fontFamily: sans, fontSize: 13, color: C.turf }}>No drive/tee shot data logged yet.</div>
                  ) : (
                    <div style={{ fontFamily: sans, fontSize: 13, color: C.ink, display: "grid", gap: 4 }}>
                      {stats.par45Count > 0 && (
                        <div>Par 4/5 drives ({stats.par45Count}): <b>{stats.fairwayPct}%</b> fairway · {stats.leftPct}% left · {stats.rightPct}% right</div>
                      )}
                      {stats.par3Count > 0 && (
                        <div>Par 3 tee shots ({stats.par3Count}): <b>{stats.girPct}%</b> on the green · {stats.par3LeftPct}% left · {stats.par3RightPct}% right</div>
                      )}
                    </div>
                  )}
                  <div style={{ fontFamily: sans, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: C.turf, margin: "14px 0 6px" }}>
                    Golf bag {(p.bag || []).length > 0 ? `(${p.bag.length})` : ""}
                  </div>
                  <div style={{ fontFamily: sans, fontSize: 12, color: C.turf, marginBottom: 8 }}>
                    Select the clubs {p.name} carries and each one's typical carry distance. Used to suggest a club during a round
                    when {p.name} is marked ⭐ as the current player — never affects scoring or history on its own.
                  </div>
                  <GolfBagEditor bag={p.bag || []} onChange={(next) => updateBag(p.id, next)} distanceUnit={distanceUnit} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ================= BETTER BALL HOLE CARD ================= */
function defaultBBHole() {
  return { rounds: [{ continueWith: null, shapeA: null, shapeB: null }], onGreen: false, puttMode: null, betterPutts: "", ownPutts: { A: "", B: "" } };
}

/* Works out, for whichever player is marked ⭐ "you", which shot (if any) is next to record —
   the tee shot if it hasn't been marked yet, otherwise the first not-yet-marked shot after that
   for whichever ball they're currently playing. Used both to anchor the auto shot-stop detector
   and to figure out what "Hey Gaddy, record shot" should do. Pure function (all inputs passed
   in explicitly) so it works the same whether called from a live render or from the voice-caddy
   callback's ref-captured snapshot of state — and so it can be unit tested without a browser.
   Returns null when there's nothing sensible to record right now (no course/hole GPS, "you"
   isn't marked, "you" aren't in this hole's group, or the ball is already close enough to the
   green that this is assumed to be short-game/putting rather than a full shot). */
function computePendingShot({ hole, format, mePlayerId, selected, scores, bbState, team1Ids, team2Ids }) {
  if (!mePlayerId || !hole || hole.teeLat == null) return null;
  const NEAR_GREEN_YARDS = 30; // inside this range, assume chipping/putting — stop prompting for full shots

  if (format === "stroke") {
    if (!selected.includes(mePlayerId)) return null;
    const cell = scores[mePlayerId]?.[hole.number] || {};
    const isDrive = cell.driveLat == null;
    let anchor;
    if (isDrive) {
      anchor = { lat: hole.teeLat, lon: hole.teeLon };
    } else {
      const extra = cell.extraShots || [];
      anchor = extra.length ? { lat: extra[extra.length - 1].lat, lon: extra[extra.length - 1].lon } : { lat: cell.driveLat, lon: cell.driveLon };
    }
    const remaining = hole.greenLat != null && anchor ? haversineYards(anchor.lat, anchor.lon, hole.greenLat, hole.greenLon) : null;
    if (!isDrive && remaining != null && remaining < NEAR_GREEN_YARDS) return null;
    return { kind: "stroke", hole, anchor, isDrive };
  }

  // better ball — can only sensibly track whichever of the two teams "you" are on
  let teamKey = null, who = null;
  if ((team1Ids || []).includes(mePlayerId)) { teamKey = "team1"; who = team1Ids[0] === mePlayerId ? "A" : "B"; }
  else if ((team2Ids || []).includes(mePlayerId)) { teamKey = "team2"; who = team2Ids[0] === mePlayerId ? "A" : "B"; }
  if (!teamKey) return null;

  const s = bbState[teamKey]?.[hole.number] || defaultBBHole();
  const driveLatField = who === "A" ? "driveLatA" : "driveLatB";
  const driveLonField = who === "A" ? "driveLonA" : "driveLonB";
  const isDrive = s.rounds[0]?.[driveLatField] == null;
  if (isDrive) return { kind: "bb", hole, teamKey, who, anchor: { lat: hole.teeLat, lon: hole.teeLon }, isDrive: true };

  let roundIndex = null;
  for (let i = s.rounds.length - 1; i >= 1; i--) {
    if (s.rounds[i - 1].continueWith === who && s.rounds[i].lat == null) { roundIndex = i; break; }
  }
  if (roundIndex == null) return null; // not currently "your" ball, or nothing pending
  const anchor = roundIndex === 1
    ? (s.rounds[0][driveLatField] != null ? { lat: s.rounds[0][driveLatField], lon: s.rounds[0][driveLonField] } : { lat: hole.teeLat, lon: hole.teeLon })
    : (s.rounds[roundIndex - 1].lat != null ? { lat: s.rounds[roundIndex - 1].lat, lon: s.rounds[roundIndex - 1].lon } : null);
  if (!anchor) return null;
  const remaining = hole.greenLat != null ? haversineYards(anchor.lat, anchor.lon, hole.greenLat, hole.greenLon) : null;
  if (remaining != null && remaining < NEAR_GREEN_YARDS) return null;
  return { kind: "bb", hole, teamKey, who, anchor, isDrive: false, roundIndex };
}
function bbHoleScore(state) {
  if (!state || !state.onGreen || !state.puttMode) return null;
  const pre = state.rounds.length;
  if (state.puttMode === "better") {
    const putts = Number(state.betterPutts);
    if (!putts) return null;
    return pre + putts;
  }
  const a = Number(state.ownPutts.A), b = Number(state.ownPutts.B);
  if (!a || !b) return null;
  return pre + Math.min(a, b);
}

function BetterBallHoleCard({ hole, teamKey, teamColor, teamLabel, playerAName, playerBName, playerAId, playerBId, state, onUpdate, onMarkDrive, onMarkShot, livePos, distanceUnit, mePlayerId, meBag }) {
  const s = state || defaultBBHole();
  const remainingYards = hole.greenLat != null && livePos ? haversineYards(livePos.lat, livePos.lon, hole.greenLat, hole.greenLon) : null;
  const suggestion = meBag?.length > 0 ? suggestClub(meBag, remainingYards) : null;

  function patch(next) { onUpdate({ ...s, ...next }); }
  function patchRound(i, next) {
    const rounds = [...s.rounds];
    rounds[i] = { ...rounds[i], ...next };
    patch({ rounds });
  }
  function addRound() {
    patch({ rounds: [...s.rounds, { continueWith: null, shapeA: null, shapeB: null }] });
  }
  function removeLastRound() {
    if (s.rounds.length <= 1) return;
    patch({ rounds: s.rounds.slice(0, -1) });
  }
  const lastRound = s.rounds[s.rounds.length - 1];
  const score = bbHoleScore(s);
  const liveLabel = score != null ? score : s.onGreen ? `${s.rounds.length}+` : `${s.rounds.length}`;

  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px", background: C.white, flex: 1, minWidth: 290 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ fontFamily: sans, fontWeight: 700, fontSize: 13, color: teamColor, textTransform: "uppercase", letterSpacing: "0.04em" }}>{teamLabel}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          <div style={{ fontFamily: mono, fontSize: 20, fontWeight: 700, color: C.ink }}>{liveLabel}</div>
          {score == null && <div style={{ fontFamily: sans, fontSize: 11, color: C.turf }}>shots so far</div>}
        </div>
      </div>
      {hole.greenLat != null && livePos && (
        <div style={{ fontFamily: sans, fontSize: 11, color: C.turf, marginBottom: 6 }}>
          📍 {Math.round(displayDistance(remainingYards, distanceUnit))}{distanceUnit === "m" ? "m" : "y"} to green (live)
          {suggestion && <span style={{ color: C.fairway, fontWeight: 700, marginLeft: 6 }}>🎒 {suggestion}</span>}
        </div>
      )}

      {!s.onGreen && (
        <div style={{ display: "grid", gap: 6 }}>
          {s.rounds.map((r, i) => {
            const label = i === 0 ? (hole.par === 3 ? "Tee shots" : "Drives") : `Shot round ${i + 1}`;
            return (
              <div key={i} style={{ fontFamily: sans, fontSize: 13 }}>
                <div style={{ color: C.turf, marginBottom: 3, fontWeight: 600 }}>{label}</div>
                {i === 0 && (
                  <div style={{ display: "flex", gap: 10, marginBottom: 4 }}>
                    <div>
                      {playerAName}
                      <ShapeSelector par={hole.par} value={r.shapeA} onChange={(v) => patchRound(i, { shapeA: v })} />
                      {hole.teeLat != null && (
                        <button style={{ ...btnGhost, fontSize: 10, padding: "3px 6px", marginTop: 4 }} onClick={() => onMarkDrive && onMarkDrive("A")}>
                          {r.driveYardsA ? `📍 ${Math.round(displayDistance(r.driveYardsA, distanceUnit))}${distanceUnit === "m" ? "m" : "y"}` : "📍 Mark"}
                        </button>
                      )}
                      <select style={{ ...inputStyle, width: 90, padding: "3px 4px", fontSize: 11, marginTop: 4 }} value={r.clubA || ""} onChange={(e) => patchRound(i, { clubA: e.target.value || null })}>
                        <option value="">Club —</option>
                        {CLUBS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      {playerAId === mePlayerId && suggestion && !r.clubA && (
                        <div style={{ fontSize: 10, color: C.fairway, fontWeight: 700, marginTop: 2 }}>🎒 {suggestion}?</div>
                      )}
                    </div>
                    <div>
                      {playerBName}
                      <ShapeSelector par={hole.par} value={r.shapeB} onChange={(v) => patchRound(i, { shapeB: v })} />
                      {hole.teeLat != null && (
                        <button style={{ ...btnGhost, fontSize: 10, padding: "3px 6px", marginTop: 4 }} onClick={() => onMarkDrive && onMarkDrive("B")}>
                          {r.driveYardsB ? `📍 ${Math.round(displayDistance(r.driveYardsB, distanceUnit))}${distanceUnit === "m" ? "m" : "y"}` : "📍 Mark"}
                        </button>
                      )}
                      <select style={{ ...inputStyle, width: 90, padding: "3px 4px", fontSize: 11, marginTop: 4 }} value={r.clubB || ""} onChange={(e) => patchRound(i, { clubB: e.target.value || null })}>
                        <option value="">Club —</option>
                        {CLUBS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      {playerBId === mePlayerId && suggestion && !r.clubB && (
                        <div style={{ fontSize: 10, color: C.fairway, fontWeight: 700, marginTop: 2 }}>🎒 {suggestion}?</div>
                      )}
                    </div>
                  </div>
                )}
                {i > 0 && (() => {
                  const whoHit = s.rounds[i - 1].continueWith;
                  const hitName = whoHit === "A" ? playerAName : whoHit === "B" ? playerBName : null;
                  const hitId = whoHit === "A" ? playerAId : whoHit === "B" ? playerBId : null;
                  if (!hitName) return null;
                  return (
                    <div style={{ marginBottom: 4, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span style={{ color: C.turf }}>{hitName}:</span>
                      {hole.teeLat != null && (
                        <button style={{ ...btnGhost, fontSize: 10, padding: "3px 6px" }} onClick={() => onMarkShot && onMarkShot(whoHit, i)}>
                          {r.shotYards != null ? `📍 ${Math.round(displayDistance(r.shotYards, distanceUnit))}${distanceUnit === "m" ? "m" : "y"}` : "📍 Mark shot"}
                        </button>
                      )}
                      <select style={{ ...inputStyle, width: 90, padding: "3px 4px", fontSize: 11 }} value={r.club || ""} onChange={(e) => patchRound(i, { club: e.target.value || null })}>
                        <option value="">Club —</option>
                        {CLUBS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      {hitId === mePlayerId && suggestion && !r.club && (
                        <span style={{ fontSize: 10, color: C.fairway, fontWeight: 700 }}>🎒 {suggestion}?</span>
                      )}
                    </div>
                  );
                })()}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {["A", "B"].map((who) => (
                    <button key={who}
                      onClick={() => patchRound(i, { continueWith: who })}
                      style={{
                        fontSize: 13, padding: "6px 10px", borderRadius: 5, cursor: "pointer", fontFamily: sans, fontWeight: 600,
                        border: `1px solid ${r.continueWith === who ? teamColor : C.line}`,
                        background: r.continueWith === who ? teamColor : C.white,
                        color: r.continueWith === who ? C.white : C.ink,
                      }}
                    >
                      {who === "A" ? playerAName : playerBName}'s Ball
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
            <button style={{ ...btnGhost, fontSize: 13, padding: "6px 12px" }} disabled={!lastRound.continueWith} onClick={addRound}>+ Shot</button>
            <button style={{ ...btnGhost, fontSize: 13, padding: "6px 12px", borderColor: C.flag, color: C.flag }} disabled={s.rounds.length <= 1} onClick={removeLastRound}>− Shot</button>
            <button style={{ ...btnGhost, fontSize: 13, padding: "6px 12px", borderColor: C.turf, color: C.turf }} disabled={!lastRound.continueWith} onClick={() => patch({ onGreen: true })}>On the green →</button>
          </div>
        </div>
      )}

      {s.onGreen && (
        <div style={{ fontFamily: sans, fontSize: 13 }}>
          <div style={{ color: C.turf, marginBottom: 6 }}>{s.rounds.length} shot{s.rounds.length !== 1 ? "s" : ""} to reach the green</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <button onClick={() => patch({ puttMode: "better" })} style={{ ...btnGhost, fontSize: 13, padding: "8px 14px", background: s.puttMode === "better" ? teamColor : C.white, color: s.puttMode === "better" ? C.white : teamColor, borderColor: teamColor }}>Putt better ball</button>
            <button onClick={() => patch({ puttMode: "own" })} style={{ ...btnGhost, fontSize: 13, padding: "8px 14px", background: s.puttMode === "own" ? teamColor : C.white, color: s.puttMode === "own" ? C.white : teamColor, borderColor: teamColor }}>Play own ball</button>
          </div>
          {s.puttMode === "better" && (
            <input type="number" style={{ ...inputStyle, width: 90 }} placeholder="putts" value={s.betterPutts} onChange={(e) => patch({ betterPutts: e.target.value })} />
          )}
          {s.puttMode === "own" && (
            <div style={{ display: "flex", gap: 14 }}>
              <div>{playerAName} <input type="number" style={{ ...inputStyle, width: 70 }} value={s.ownPutts.A} onChange={(e) => patch({ ownPutts: { ...s.ownPutts, A: e.target.value } })} /></div>
              <div>{playerBName} <input type="number" style={{ ...inputStyle, width: 70 }} value={s.ownPutts.B} onChange={(e) => patch({ ownPutts: { ...s.ownPutts, B: e.target.value } })} /></div>
            </div>
          )}
          <button style={{ ...btnGhost, fontSize: 12, padding: "6px 12px", marginTop: 10 }} onClick={() => patch({ onGreen: false })}>← Back off the green</button>
        </div>
      )}
    </div>
  );
}

/* ================= PLAY TAB ================= */
function PlayTab({ courses, players, setPlayers, rounds, setRounds, distanceUnit, mePlayerId, voiceWakeWord }) {
  /* resume an in-progress round after an accidental tab/app close — read once at mount */
  const [savedRound] = useState(() => loadKey(ACTIVE_ROUND_KEY, null));
  const [step, setStep] = useState(savedRound ? "scoring" : "setup");
  const [format, setFormat] = useState(savedRound?.format || "stroke");
  const [courseId, setCourseId] = useState(savedRound?.courseId || courses[0]?.id || "");
  const [selected, setSelected] = useState(savedRound?.selected || []);
  const [overrides, setOverrides] = useState(savedRound?.overrides || {});
  const [scores, setScores] = useState(savedRound?.scores || {});
  const [teamAssign, setTeamAssign] = useState(savedRound?.teamAssign || {});
  const [bbState, setBbState] = useState(savedRound?.bbState || { team1: {}, team2: {} });
  const [driveModal, setDriveModal] = useState(null);
  const [voiceOn, setVoiceOn] = useState(false);
  const [voiceMsg, setVoiceMsg] = useState("");
  const [resumedNotice, setResumedNotice] = useState(!!savedRound);

  const course = courses.find((c) => c.id === courseId);
  const livePos = useLivePosition(step === "scoring");
  const mePlayer = players.find((p) => p.id === mePlayerId);

  useEffect(() => {
    if (!courseId && courses.length) setCourseId(courses[0].id);
  }, [courses]);

  /* if the resumed round's course was deleted since, there's nothing sensible to score against */
  useEffect(() => {
    if (step === "scoring" && !course && courses.length) {
      setStep("setup");
      saveKey(ACTIVE_ROUND_KEY, null);
    }
  }, [step, course, courses]);

  /* persist the in-progress round on every change, so closing the tab/app mid-round doesn't
     lose it — only while actively scoring; the setup screen and finished rounds don't persist */
  useEffect(() => {
    if (step !== "scoring") return;
    saveKey(ACTIVE_ROUND_KEY, { format, courseId, selected, overrides, scores, teamAssign, bbState });
  }, [step, format, courseId, selected, overrides, scores, teamAssign, bbState]);

  function togglePlayer(id) {
    if (selected.includes(id)) {
      setSelected(selected.filter((s) => s !== id));
      const next = { ...teamAssign }; delete next[id]; setTeamAssign(next);
    } else if (selected.length < 4) setSelected([...selected, id]);
  }
  function setTeam(pid, team) { setTeamAssign({ ...teamAssign, [pid]: team }); }

  const isTwoBall = selected.length === 2;
  const isFourBall = selected.length === 4;
  const team1Ids = format === "betterball" && isTwoBall ? selected : selected.filter((pid) => teamAssign[pid] === 1);
  const team2Ids = format === "betterball" && isTwoBall ? [] : selected.filter((pid) => teamAssign[pid] === 2);
  const teamsReady =
    format !== "betterball" ? true
    : isTwoBall ? true
    : isFourBall ? team1Ids.length === 2 && team2Ids.length === 2
    : false;

  function beginRound() {
    if (!course) return;
    if (format === "stroke") {
      const init = {};
      selected.forEach((pid) => { init[pid] = {}; });
      setScores(init);
    } else {
      setBbState({ team1: {}, team2: {} });
    }
    setStep("scoring");
  }

  function setScoreField(pid, holeNum, field, val) {
    setScores((prev) => ({
      ...prev,
      [pid]: { ...prev[pid], [holeNum]: { ...(prev[pid]?.[holeNum] || {}), [field]: val } },
    }));
  }

  function patchBBClub(teamKey, holeNumber, who, club) {
    setBbState((prev) => {
      const s = prev[teamKey]?.[holeNumber] || defaultBBHole();
      const rounds = [...s.rounds];
      const lastIdx = rounds.length - 1;
      rounds[lastIdx] = { ...rounds[lastIdx], [who === "A" ? "clubA" : "clubB"]: club };
      return { ...prev, [teamKey]: { ...prev[teamKey], [holeNumber]: { ...s, rounds } } };
    });
  }

  /* --- shot recording: always reads/writes via the functional setState form so these stay
     correct even when called from the voice-caddy callback below, whose own closure is only
     ever created once (see the refs a little further down) --- */
  function recordStrokeDrive(pid, hole, pos) {
    let result = null;
    setScores((prev) => {
      const cell = prev[pid]?.[hole.number] || {};
      const anchor = hole.teeLat != null ? { lat: hole.teeLat, lon: hole.teeLon } : null;
      const yards = anchor ? haversineYards(anchor.lat, anchor.lon, pos.lat, pos.lon) : null;
      const remaining = hole.greenLat != null ? haversineYards(pos.lat, pos.lon, hole.greenLat, hole.greenLon) : null;
      result = { label: "Drive", yards, remaining };
      const nextCell = { ...cell, driveYards: yards != null ? Math.round(yards) : null, driveLat: pos.lat, driveLon: pos.lon };
      return { ...prev, [pid]: { ...prev[pid], [hole.number]: nextCell } };
    });
    return result;
  }
  function recordStrokeNextShot(pid, hole, pos) {
    let result = null;
    setScores((prev) => {
      const cell = prev[pid]?.[hole.number] || {};
      const extra = cell.extraShots || [];
      const prevPt = extra.length
        ? { lat: extra[extra.length - 1].lat, lon: extra[extra.length - 1].lon }
        : cell.driveLat != null
        ? { lat: cell.driveLat, lon: cell.driveLon }
        : hole.teeLat != null
        ? { lat: hole.teeLat, lon: hole.teeLon }
        : null;
      const yards = prevPt ? haversineYards(prevPt.lat, prevPt.lon, pos.lat, pos.lon) : null;
      const remaining = hole.greenLat != null ? haversineYards(pos.lat, pos.lon, hole.greenLat, hole.greenLon) : null;
      result = { label: `Shot ${extra.length + 2}`, yards, remaining };
      const nextExtra = [...extra, { yards: yards != null ? Math.round(yards) : null, lat: pos.lat, lon: pos.lon, club: null }];
      return { ...prev, [pid]: { ...prev[pid], [hole.number]: { ...cell, extraShots: nextExtra } } };
    });
    return result;
  }
  function recordBBDrive(teamKey, who, hole, pos) {
    let result = null;
    setBbState((prev) => {
      const s = prev[teamKey]?.[hole.number] || defaultBBHole();
      const rounds = [...s.rounds];
      const driveLatField = who === "A" ? "driveLatA" : "driveLatB";
      const driveLonField = who === "A" ? "driveLonA" : "driveLonB";
      const driveYardsField = who === "A" ? "driveYardsA" : "driveYardsB";
      const anchor = hole.teeLat != null ? { lat: hole.teeLat, lon: hole.teeLon } : null;
      const yards = anchor ? haversineYards(anchor.lat, anchor.lon, pos.lat, pos.lon) : null;
      const remaining = hole.greenLat != null ? haversineYards(pos.lat, pos.lon, hole.greenLat, hole.greenLon) : null;
      result = { label: "Drive", yards, remaining };
      rounds[0] = { ...rounds[0], [driveYardsField]: yards != null ? Math.round(yards) : null, [driveLatField]: pos.lat, [driveLonField]: pos.lon };
      return { ...prev, [teamKey]: { ...prev[teamKey], [hole.number]: { ...s, rounds } } };
    });
    return result;
  }
  /* marks the shot at an explicit round index — used both by the manual per-round "Mark shot"
     button (which already knows exactly which round it's for) and, via computePendingShot's
     roundIndex, by the auto-detect/voice paths */
  function recordBBShotAtRound(teamKey, who, hole, roundIndex, pos) {
    let result = null;
    setBbState((prev) => {
      const s = prev[teamKey]?.[hole.number] || defaultBBHole();
      const rounds = [...s.rounds];
      if (!rounds[roundIndex]) return prev;
      const driveLatField = who === "A" ? "driveLatA" : "driveLatB";
      const driveLonField = who === "A" ? "driveLonA" : "driveLonB";
      const anchor = roundIndex === 1
        ? rounds[0][driveLatField] != null
          ? { lat: rounds[0][driveLatField], lon: rounds[0][driveLonField] }
          : hole.teeLat != null ? { lat: hole.teeLat, lon: hole.teeLon } : null
        : rounds[roundIndex - 1]?.lat != null
        ? { lat: rounds[roundIndex - 1].lat, lon: rounds[roundIndex - 1].lon }
        : null;
      const yards = anchor ? haversineYards(anchor.lat, anchor.lon, pos.lat, pos.lon) : null;
      const remaining = hole.greenLat != null ? haversineYards(pos.lat, pos.lon, hole.greenLat, hole.greenLon) : null;
      result = { label: `Shot ${roundIndex + 1}`, yards, remaining };
      rounds[roundIndex] = { ...rounds[roundIndex], shotYards: yards != null ? Math.round(yards) : null, lat: pos.lat, lon: pos.lon };
      return { ...prev, [teamKey]: { ...prev[teamKey], [hole.number]: { ...s, rounds } } };
    });
    return result;
  }

  /* shows the club suggestion + distance for a just-recorded shot next to the voice caddy
     button, and — for the voice/auto-detect paths, or when voice caddy is on — reads it aloud */
  function announceShotResult(result, { speakAloud } = {}) {
    if (!result) return;
    const suggestion = mePlayer?.bag?.length ? suggestClub(mePlayer.bag, result.remaining) : null;
    const yardsTxt = result.yards != null ? `${Math.round(displayDistance(result.yards, distanceUnit))}${distanceUnit === "m" ? "m" : "y"}` : null;
    const remainTxt = result.remaining != null ? `${Math.round(displayDistance(result.remaining, distanceUnit))}${distanceUnit === "m" ? "m" : "y"} to the green` : null;
    const parts = [`${result.label} marked${yardsTxt ? ` (${yardsTxt})` : ""}`];
    if (remainTxt) parts.push(remainTxt);
    if (suggestion) parts.push(`suggested next club: ${suggestion}`);
    setVoiceMsg(parts.join(" · "));
    if (speakAloud) {
      const spoken = [`${result.label} recorded.`];
      if (remainTxt) spoken.push(`${remainTxt}.`);
      if (suggestion) spoken.push(`Suggested club: ${suggestion}.`);
      speak(spoken.join(" "));
    }
  }

  /* refs so the voice-caddy callback (bound once when listening starts) always sees fresh values */
  const mePlayerIdRef = useRef(mePlayerId);
  const livePosRef = useRef(livePos);
  const courseRef = useRef(course);
  const formatRef = useRef(format);
  const selectedRef = useRef(selected);
  const scoresRef = useRef(scores);
  const bbStateRef = useRef(bbState);
  const team1IdsRef = useRef(team1Ids);
  const team2IdsRef = useRef(team2Ids);
  useEffect(() => { mePlayerIdRef.current = mePlayerId; }, [mePlayerId]);
  useEffect(() => { livePosRef.current = livePos; }, [livePos]);
  useEffect(() => { courseRef.current = course; }, [course]);
  useEffect(() => { formatRef.current = format; }, [format]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { scoresRef.current = scores; }, [scores]);
  useEffect(() => { bbStateRef.current = bbState; }, [bbState]);
  useEffect(() => { team1IdsRef.current = team1Ids; });
  useEffect(() => { team2IdsRef.current = team2Ids; });

  const handleVoiceCommand = useCallback((kind, payload, transcript) => {
    if (kind === "error") {
      // no spoken reply — if speech recognition itself is broken, speaking to the user via the
      // same broken pipeline's assumptions isn't reliable, and a silent visible message is safer
      const known = { network: "couldn't reach the speech recognition service", "not-allowed": "microphone access was blocked", "service-not-allowed": "speech recognition isn't allowed here", "audio-capture": "no microphone was found" };
      const why = known[payload] || `error: ${payload}`;
      setVoiceMsg(`Voice caddy stopped hearing anything (${why}). Some browsers — Brave is the known one — start the mic but don't actually run speech recognition. Try Chrome if this keeps happening.`);
      return;
    }
    const me = mePlayerIdRef.current;
    if (!me) { setVoiceMsg("Mark a player as ⭐ you in the Players tab first."); speak("Mark a player as you first."); return; }
    const crs = courseRef.current;
    const hole = crs ? nearestHoleByPosition(crs.holes, livePosRef.current) : null;
    if (!hole) { setVoiceMsg(`Heard "${transcript}" but can't tell which hole you're on yet — enable location.`); speak("Can't tell which hole you're on yet."); return; }

    if (kind === "unmatched") {
      // deliberately no spoken reply here — a wake word alone shouldn't interrupt mid-swing;
      // the visible transcript is what lets a mis-heard phrase be diagnosed instead of looking
      // like the mic just isn't picking anything up at all
      setVoiceMsg(`Heard: "${transcript}" — didn't catch a club name or "record shot". Try "I'm using a 6 iron" or "record shot".`);
      return;
    }
    if (kind === "club") {
      if (formatRef.current === "stroke") {
        setScoreField(me, hole.number, "club", payload);
      } else {
        const t1 = team1IdsRef.current, t2 = team2IdsRef.current;
        let teamKey = null, who = null;
        if (t1.includes(me)) { teamKey = "team1"; who = t1[0] === me ? "A" : "B"; }
        else if (t2.includes(me)) { teamKey = "team2"; who = t2[0] === me ? "A" : "B"; }
        if (teamKey) patchBBClub(teamKey, hole.number, who, payload);
      }
      setVoiceMsg(`Logged ${payload} for hole ${hole.number}.`);
      speak(`Logged ${payload} for hole ${hole.number}`);
      return;
    }
    if (kind === "recordShot") {
      const pos = livePosRef.current;
      if (!pos) { setVoiceMsg('Heard "record shot" but don\'t have your GPS position yet.'); speak("Don't have your location yet."); return; }
      const pending = computePendingShot({
        hole, format: formatRef.current, mePlayerId: me, selected: selectedRef.current,
        scores: scoresRef.current, bbState: bbStateRef.current,
        team1Ids: team1IdsRef.current, team2Ids: team2IdsRef.current,
      });
      if (!pending) { setVoiceMsg('Heard "record shot" but there\'s nothing pending to mark for you right now.'); speak("Nothing to record right now."); return; }
      const posArg = { lat: pos.lat, lon: pos.lon };
      let result;
      if (pending.kind === "stroke") {
        result = pending.isDrive ? recordStrokeDrive(me, hole, posArg) : recordStrokeNextShot(me, hole, posArg);
      } else {
        result = pending.isDrive
          ? recordBBDrive(pending.teamKey, pending.who, hole, posArg)
          : recordBBShotAtRound(pending.teamKey, pending.who, hole, pending.roundIndex, posArg);
      }
      announceShotResult(result, { speakAloud: true });
    }
  }, []);

  useVoiceCaddy(voiceOn && step === "scoring", handleVoiceCommand, voiceWakeWord);

  /* auto shot-stop detection — scoped to "you" only, see computePendingShot/shotDetectorStep */
  const currentHoleForMe = course && livePos ? nearestHoleByPosition(course.holes, livePos) : null;
  const myPending = step === "scoring"
    ? computePendingShot({ hole: currentHoleForMe, format, mePlayerId, selected, scores, bbState, team1Ids, team2Ids })
    : null;
  const shotDetector = useShotStopDetector(step === "scoring" && !!myPending, livePos, myPending?.anchor || null);

  function openAutoShotModal(pending, pos) {
    const label = mePlayer?.name || "You";
    setDriveModal({
      hole: pending.hole,
      label,
      shotLabel: pending.isDrive ? "drive" : "next shot",
      fromLat: pending.anchor?.lat,
      fromLon: pending.anchor?.lon,
      initialPos: { lat: pos.lat, lng: pos.lon },
      onSave: (yd, lat, lng) => {
        const posArg = { lat, lon: lng };
        const result = pending.kind === "stroke"
          ? pending.isDrive ? recordStrokeDrive(mePlayerId, pending.hole, posArg) : recordStrokeNextShot(mePlayerId, pending.hole, posArg)
          : pending.isDrive
          ? recordBBDrive(pending.teamKey, pending.who, pending.hole, posArg)
          : recordBBShotAtRound(pending.teamKey, pending.who, pending.hole, pending.roundIndex, posArg);
        announceShotResult(result, { speakAloud: voiceOn });
        setDriveModal(null);
        shotDetector.reset();
      },
    });
  }

  function abandonRound() {
    setStep("setup");
    saveKey(ACTIVE_ROUND_KEY, null);
    setResumedNotice(false);
  }

  function playerHandicapIndex(pid) {
    if (overrides[pid] != null && overrides[pid] !== "") return Number(overrides[pid]);
    const p = players.find((x) => x.id === pid);
    return p ? computeHandicapIndex(p.differentials.map((d) => d.value)) : null;
  }

  const par = course ? parTotal(course) : 0;

  function finishStrokeRound() {
    const date = new Date().toISOString().slice(0, 10);
    const roundScores = {};
    const updatedPlayers = players.map((p) => ({ ...p, differentials: [...p.differentials], shotStats: [...(p.shotStats || [])] }));

    selected.forEach((pid) => {
      const holesObj = {};
      let gross = 0;
      course.holes.forEach((h) => {
        const cell = scores[pid]?.[h.number] || {};
        const g = Number(cell.gross) || 0;
        gross += g;
        holesObj[h.number] = { gross: cell.gross ?? "", shape: cell.shape ?? null, putts: cell.putts ?? "", driveYards: cell.driveYards ?? null, club: cell.club ?? null };
        const pIdx = updatedPlayers.findIndex((p) => p.id === pid);
        if (pIdx >= 0 && cell.shape) {
          updatedPlayers[pIdx].shotStats.push({ date, courseName: course.name, par: h.par, shape: cell.shape });
        }
      });
      const hi = playerHandicapIndex(pid);
      const ch = courseHandicap(hi, course.slope, course.rating, par);
      const net = gross - ch;
      roundScores[pid] = { holes: holesObj, gross, net, courseHandicap: ch };

      const rating = course.rating != null ? course.rating : par;
      const slope = course.slope || 113;
      const differential = ((gross - rating) * 113) / slope;
      const pIdx = updatedPlayers.findIndex((p) => p.id === pid);
      if (pIdx >= 0) updatedPlayers[pIdx].differentials.push({ value: Math.round(differential * 10) / 10, date, courseName: course.name });
    });

    const newRound = { id: uid(), format: "stroke", date, courseId: course.id, courseName: course.name, par, playerIds: [...selected], scores: roundScores };
    setRounds([newRound, ...rounds]);
    setPlayers(updatedPlayers);
    resetAll();
  }

  function finishBetterBallRound() {
    const date = new Date().toISOString().slice(0, 10);
    const updatedPlayers = players.map((p) => ({ ...p, shotStats: [...(p.shotStats || [])] }));

    function buildTeam(teamKey, ids) {
      const holeScores = {};
      const holeDetails = {};
      let total = 0, complete = true;
      course.holes.forEach((h) => {
        const st = bbState[teamKey]?.[h.number];
        const sc = bbHoleScore(st);
        holeScores[h.number] = sc;
        if (sc == null) complete = false; else total += sc;
        if (st) holeDetails[h.number] = st;
        const firstRound = st?.rounds?.[0];
        if (firstRound) {
          const pIdxA = updatedPlayers.findIndex((p) => p.id === ids[0]);
          const pIdxB = updatedPlayers.findIndex((p) => p.id === ids[1]);
          if (pIdxA >= 0 && firstRound.shapeA) updatedPlayers[pIdxA].shotStats.push({ date, courseName: course.name, par: h.par, shape: firstRound.shapeA });
          if (pIdxB >= 0 && firstRound.shapeB) updatedPlayers[pIdxB].shotStats.push({ date, courseName: course.name, par: h.par, shape: firstRound.shapeB });
        }
      });
      return { playerIds: ids, holeScores, holeDetails, total: complete ? total : total, complete };
    }

    const solo = team2Ids.length === 0;
    const team1 = buildTeam("team1", team1Ids);
    const teams = solo
      ? [{ name: "Better Ball", ...team1 }]
      : [{ name: "Team 1", ...team1 }, { name: "Team 2", ...buildTeam("team2", team2Ids) }];
    const newRound = {
      id: uid(), format: "betterball", date, courseId: course.id, courseName: course.name, par,
      teams,
    };
    setRounds([newRound, ...rounds]);
    setPlayers(updatedPlayers);
    resetAll();
  }

  function resetAll() {
    setStep("setup"); setSelected([]); setOverrides({}); setScores({}); setTeamAssign({}); setBbState({ team1: {}, team2: {} });
    saveKey(ACTIVE_ROUND_KEY, null);
    setResumedNotice(false);
  }

  if (courses.length === 0) return <div style={emptyStyle}>Add a course in the Courses tab before starting a round.</div>;
  if (players.length === 0) return <div style={emptyStyle}>Add players in the Players tab before starting a round.</div>;

  if (step === "setup") {
    return (
      <div>
        <Field label="Course">
          <select style={inputStyle} value={courseId} onChange={(e) => setCourseId(e.target.value)}>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.name} (Par {parTotal(c)})</option>)}
          </select>
        </Field>

        <div style={{ fontFamily: sans, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: C.turf, margin: "14px 0 8px" }}>Format</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <button style={{ ...btnGhost, background: format === "stroke" ? C.fairway : C.white, color: format === "stroke" ? C.white : C.fairway }} onClick={() => setFormat("stroke")}>Individual stroke play</button>
          <button style={{ ...btnGhost, background: format === "betterball" ? C.fairway : C.white, color: format === "betterball" ? C.white : C.fairway }} onClick={() => setFormat("betterball")}>Better ball</button>
        </div>
        <div style={{ fontFamily: sans, fontSize: 12, color: C.turf, marginBottom: 16 }}>
          {format === "betterball" ? "Works as a two-ball (you and a partner sharing one team score) or a four-ball (two teams of two)." : "One to four players, each scored individually."}
        </div>

        <div style={{ fontFamily: sans, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: C.turf, margin: "14px 0 8px" }}>
          Select {format === "betterball" ? "2 or 4" : "up to 4"} players
        </div>
        <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
          {players.map((p) => {
            const on = selected.includes(p.id);
            const hi = computeHandicapIndex(p.differentials.map((d) => d.value));
            return (
              <div key={p.id} onClick={() => togglePlayer(p.id)}
                style={{ ...cardStyle, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center",
                  borderColor: on ? C.fairway : C.line, background: on ? C.paper2 : C.white }}>
                <div style={{ fontFamily: sans, fontSize: 14, fontWeight: on ? 700 : 400, color: C.ink }}>{p.name}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: mono, fontSize: 13, color: C.turf }}>{hi != null ? `HI ${hi.toFixed(1)}` : "HI —"}</span>
                  {on && format === "stroke" && (
                    <input
                      style={{ ...inputStyle, width: 70, padding: "4px 6px" }}
                      placeholder="override"
                      value={overrides[p.id] ?? ""}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setOverrides({ ...overrides, [p.id]: e.target.value })}
                    />
                  )}
                  {on && format === "betterball" && isFourBall && (
                    <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 6 }}>
                      {[1, 2].map((t) => (
                        <button key={t} onClick={() => setTeam(p.id, t)}
                          style={{ fontSize: 13, padding: "6px 12px", borderRadius: 5, cursor: "pointer", fontFamily: sans, fontWeight: 600,
                            border: `1px solid ${teamAssign[p.id] === t ? (t === 1 ? C.team1 : C.team2) : C.line}`,
                            background: teamAssign[p.id] === t ? (t === 1 ? C.team1 : C.team2) : C.white,
                            color: teamAssign[p.id] === t ? C.white : C.ink }}>
                          Team {t}
                        </button>
                      ))}
                    </div>
                  )}
                  {on && format === "betterball" && isTwoBall && (
                    <span style={{ fontFamily: sans, fontSize: 12, color: C.turf }}>Partners</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {format === "betterball" && isFourBall && !teamsReady && (
          <div style={{ fontFamily: sans, fontSize: 12, color: C.flag, marginBottom: 10 }}>Assign exactly 2 players to Team 1 and 2 to Team 2.</div>
        )}
        {format === "betterball" && selected.length > 0 && !isTwoBall && !isFourBall && (
          <div style={{ fontFamily: sans, fontSize: 12, color: C.flag, marginBottom: 10 }}>Better ball needs exactly 2 or 4 players — pick a different count or switch to stroke play.</div>
        )}
        <button style={btnPrimary} disabled={selected.length === 0 || !teamsReady} onClick={beginRound}>Start round →</button>
      </div>
    );
  }

  /* ---- scoring: stroke play ---- */
  if (format === "stroke") {
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontFamily: serif, fontSize: 19, color: C.fairway }}>{course.name}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <VoiceCaddyButton voiceOn={voiceOn} setVoiceOn={setVoiceOn} voiceMsg={voiceMsg} mePlayer={mePlayer} wakeWord={voiceWakeWord} />
            <button style={{ ...btnGhost, fontSize: 12 }} onClick={abandonRound}>← Back to setup</button>
          </div>
        </div>
        {resumedNotice && (
          <div style={{ background: C.paper2, border: `1px solid ${C.brass}`, borderRadius: 6, padding: "8px 12px", fontFamily: sans, fontSize: 12, color: C.fairway, marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Resumed your in-progress round.</span>
            <button onClick={() => setResumedNotice(false)} style={{ background: "transparent", border: "none", color: C.fairway, cursor: "pointer", fontSize: 14 }}>×</button>
          </div>
        )}
        <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontFamily: mono, fontSize: 13 }}>
            <thead>
              <tr style={{ background: C.fairway }}>
                <th style={{ ...thStyle, color: C.white, background: C.fairway }}>Hole</th>
                <th style={{ ...thStyle, color: C.white, background: C.fairway }}>Par</th>
                <th style={{ ...thStyle, color: C.white, background: C.fairway }}>{distanceUnit === "m" ? "m" : "Yds"}</th>
                {selected.map((pid) => (
                  <th key={pid} style={{ ...thStyle, color: C.white, background: C.fairway }}>{players.find((p) => p.id === pid)?.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {course.holes.map((h) => (
                <tr key={h.number}>
                  <td style={tdStyle}>{h.number}</td>
                  <td style={tdStyle}>{h.par}</td>
                  <td style={tdStyle}>
                    {displayDistance(h.yardage, distanceUnit) || "—"}
                    {h.greenLat != null && livePos && (
                      <div style={{ fontSize: 11, color: C.turf, fontFamily: sans, marginTop: 2 }}>
                        📍 {Math.round(displayDistance(haversineYards(livePos.lat, livePos.lon, h.greenLat, h.greenLon), distanceUnit))} live
                        {mePlayer?.bag?.length > 0 && (() => {
                          const suggestion = suggestClub(mePlayer.bag, haversineYards(livePos.lat, livePos.lon, h.greenLat, h.greenLon));
                          return suggestion ? <div style={{ color: C.fairway, fontWeight: 700, marginTop: 1 }}>🎒 {suggestion}</div> : null;
                        })()}
                      </div>
                    )}
                  </td>
                  {selected.map((pid) => {
                    const cell = scores[pid]?.[h.number] || {};
                    return (
                      <td key={pid} style={tdStyle}>
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                          <input
                            type="number"
                            style={{ width: 52, padding: "6px 8px", fontFamily: mono, fontSize: 16, border: `1px solid ${C.line}`, borderRadius: 5 }}
                            value={cell.gross ?? ""}
                            onChange={(e) => setScoreField(pid, h.number, "gross", e.target.value)}
                          />
                          <ScoreBadge gross={cell.gross} par={h.par} />
                        </div>
                        <ShapeSelector par={h.par} value={cell.shape} onChange={(v) => setScoreField(pid, h.number, "shape", v)} />
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5 }}>
                          <span style={{ fontSize: 12, color: C.turf, fontFamily: sans }}>Putts</span>
                          <input
                            type="number"
                            style={{ width: 42, padding: "4px 6px", fontFamily: mono, fontSize: 14, border: `1px solid ${C.line}`, borderRadius: 4 }}
                            value={cell.putts ?? ""}
                            onChange={(e) => setScoreField(pid, h.number, "putts", e.target.value)}
                          />
                        </div>
                        {h.teeLat != null && (
                          <button
                            style={{ ...btnGhost, fontSize: 10, padding: "3px 6px", marginTop: 5 }}
                            onClick={() => setDriveModal({
                              hole: h,
                              label: players.find((p) => p.id === pid)?.name || "Player",
                              shotLabel: "drive",
                              onSave: (yd, lat, lng) => {
                                const result = recordStrokeDrive(pid, h, { lat, lon: lng });
                                if (pid === mePlayerId) announceShotResult(result, { speakAloud: false });
                                setDriveModal(null);
                              },
                            })}
                          >
                            {cell.driveYards ? `📍 ${Math.round(displayDistance(cell.driveYards, distanceUnit))}${distanceUnit === "m" ? "m" : "y"}` : "📍 Mark drive"}
                          </button>
                        )}
                        <select
                          style={{ ...inputStyle, width: "100%", padding: "3px 4px", fontSize: 11, marginTop: 5 }}
                          value={cell.club || ""}
                          onChange={(e) => setScoreField(pid, h.number, "club", e.target.value || null)}
                        >
                          <option value="">Club —</option>
                          {CLUBS.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                        {h.teeLat != null && (
                          <div style={{ marginTop: 4 }}>
                            {(cell.extraShots || []).map((es, i) => (
                              <div key={i} style={{ fontSize: 10, color: C.turf, fontFamily: sans, marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}>
                                <span>Shot {i + 2}: {es.yards != null ? `${Math.round(displayDistance(es.yards, distanceUnit))}${distanceUnit === "m" ? "m" : "y"}` : "—"}</span>
                                <select
                                  style={{ ...inputStyle, width: 72, padding: "2px 3px", fontSize: 10 }}
                                  value={es.club || ""}
                                  onChange={(e) => {
                                    const next = [...(cell.extraShots || [])];
                                    next[i] = { ...next[i], club: e.target.value || null };
                                    setScoreField(pid, h.number, "extraShots", next);
                                  }}
                                >
                                  <option value="">Club —</option>
                                  {CLUBS.map((c) => <option key={c} value={c}>{c}</option>)}
                                </select>
                              </div>
                            ))}
                            <button
                              style={{ ...btnGhost, fontSize: 10, padding: "3px 6px", marginTop: 4 }}
                              onClick={() => {
                                const extra = cell.extraShots || [];
                                const prevPt = extra.length ? extra[extra.length - 1] : cell.driveLat != null ? { lat: cell.driveLat, lon: cell.driveLon } : null;
                                setDriveModal({
                                  hole: h,
                                  label: players.find((p) => p.id === pid)?.name || "Player",
                                  shotLabel: "next shot",
                                  fromLat: prevPt?.lat, fromLon: prevPt?.lon,
                                  onSave: (yd, lat, lng) => {
                                    const result = recordStrokeNextShot(pid, h, { lat, lon: lng });
                                    if (pid === mePlayerId) announceShotResult(result, { speakAloud: false });
                                    setDriveModal(null);
                                  },
                                });
                              }}
                            >
                              + Mark next shot
                            </button>
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr style={{ background: C.paper2, fontWeight: 700 }}>
                <td style={tdStyle} colSpan={3}>Gross total</td>
                {selected.map((pid) => {
                  const gross = course.holes.reduce((s, h) => s + (Number(scores[pid]?.[h.number]?.gross) || 0), 0);
                  return <td key={pid} style={tdStyle}>{gross}</td>;
                })}
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 16, textAlign: "right" }}>
          <button style={btnPrimary} onClick={finishStrokeRound}>Finish & save round</button>
        </div>
        {driveModal && (
          <DriveMapModal
            hole={driveModal.hole}
            label={driveModal.label}
            shotLabel={driveModal.shotLabel}
            fromLat={driveModal.fromLat}
            fromLon={driveModal.fromLon}
            initialPos={driveModal.initialPos}
            distanceUnit={distanceUnit}
            onCancel={() => setDriveModal(null)}
            onSave={driveModal.onSave}
          />
        )}
        {shotDetector.fired && myPending && !driveModal && (
          <ShotStopPrompt
            hole={myPending.hole}
            onDismiss={() => shotDetector.reset()}
            onMark={() => { if (shotDetector.stoppedAt) openAutoShotModal(myPending, shotDetector.stoppedAt); }}
          />
        )}
      </div>
    );
  }

  /* ---- scoring: better ball ---- */
  const pA1 = players.find((p) => p.id === team1Ids[0]), pB1 = players.find((p) => p.id === team1Ids[1]);
  const pA2 = players.find((p) => p.id === team2Ids[0]), pB2 = players.find((p) => p.id === team2Ids[1]);
  const solo = team2Ids.length === 0;

  function updateBB(teamKey, holeNumber, nextState) {
    setBbState((prev) => ({ ...prev, [teamKey]: { ...prev[teamKey], [holeNumber]: nextState } }));
  }
  function markDriveForBB(teamKey, h, who, currentState, playerName) {
    setDriveModal({
      hole: h,
      label: playerName || "Player",
      shotLabel: "drive",
      onSave: (yd, lat, lng) => {
        const result = recordBBDrive(teamKey, who, h, { lat, lon: lng });
        const pid = who === "A" ? (teamKey === "team1" ? team1Ids[0] : team2Ids[0]) : (teamKey === "team1" ? team1Ids[1] : team2Ids[1]);
        if (pid === mePlayerId) announceShotResult(result, { speakAloud: false });
        setDriveModal(null);
      },
    });
  }
  function markNextShotForBB(teamKey, h, who, roundIndex, playerName) {
    const s = bbState[teamKey]?.[h.number] || defaultBBHole();
    const driveLatField = who === "A" ? "driveLatA" : "driveLatB";
    const driveLonField = who === "A" ? "driveLonA" : "driveLonB";
    const anchor = roundIndex === 1
      ? s.rounds[0]?.[driveLatField] != null
        ? { lat: s.rounds[0][driveLatField], lon: s.rounds[0][driveLonField] }
        : h.teeLat != null ? { lat: h.teeLat, lon: h.teeLon } : null
      : s.rounds[roundIndex - 1]?.lat != null
      ? { lat: s.rounds[roundIndex - 1].lat, lon: s.rounds[roundIndex - 1].lon }
      : null;
    setDriveModal({
      hole: h,
      label: playerName || "Player",
      shotLabel: `shot ${roundIndex + 1}`,
      fromLat: anchor?.lat, fromLon: anchor?.lon,
      onSave: (yd, lat, lng) => {
        const result = recordBBShotAtRound(teamKey, who, h, roundIndex, { lat, lon: lng });
        const pid = who === "A" ? (teamKey === "team1" ? team1Ids[0] : team2Ids[0]) : (teamKey === "team1" ? team1Ids[1] : team2Ids[1]);
        if (pid === mePlayerId) announceShotResult(result, { speakAloud: false });
        setDriveModal(null);
      },
    });
  }
  const t1Total = course.holes.reduce((s, h) => s + (bbHoleScore(bbState.team1?.[h.number]) || 0), 0);
  const t2Total = course.holes.reduce((s, h) => s + (bbHoleScore(bbState.team2?.[h.number]) || 0), 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontFamily: serif, fontSize: 19, color: C.fairway }}>{course.name} — Better Ball</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <VoiceCaddyButton voiceOn={voiceOn} setVoiceOn={setVoiceOn} voiceMsg={voiceMsg} mePlayer={mePlayer} wakeWord={voiceWakeWord} />
          <button style={{ ...btnGhost, fontSize: 12 }} onClick={abandonRound}>← Back to setup</button>
        </div>
      </div>
      {resumedNotice && (
        <div style={{ background: C.paper2, border: `1px solid ${C.brass}`, borderRadius: 6, padding: "8px 12px", fontFamily: sans, fontSize: 12, color: C.fairway, marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Resumed your in-progress round.</span>
          <button onClick={() => setResumedNotice(false)} style={{ background: "transparent", border: "none", color: C.fairway, cursor: "pointer", fontSize: 14 }}>×</button>
        </div>
      )}
      <div style={{ fontFamily: sans, fontSize: 12, color: C.turf, marginBottom: 14 }}>
        {solo ? (
          <>Score ({pA1?.name} & {pB1?.name}): <b style={{ color: C.team1 }}>{t1Total}</b></>
        ) : (
          <>
            Team 1 ({pA1?.name} & {pB1?.name}): <b style={{ color: C.team1 }}>{t1Total}</b> &nbsp;·&nbsp;
            Team 2 ({pA2?.name} & {pB2?.name}): <b style={{ color: C.team2 }}>{t2Total}</b>
          </>
        )}
        <div style={{ marginTop: 4 }}>Better-ball rounds are logged in history but don't count toward individual handicap index.</div>
      </div>
      <div style={{ display: "grid", gap: 14 }}>
        {course.holes.map((h) => (
          <div key={h.number}>
            <div style={{ fontFamily: sans, fontSize: 12, fontWeight: 700, color: C.ink, marginBottom: 4 }}>
              Hole {h.number} · Par {h.par}{h.yardage ? ` · ${displayDistance(h.yardage, distanceUnit)} ${distanceUnit === "m" ? "m" : "yds"}` : ""}
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <BetterBallHoleCard hole={h} teamKey="team1" teamColor={C.team1} teamLabel={solo ? "Better Ball" : "Team 1"} playerAName={pA1?.name || "A"} playerBName={pB1?.name || "B"}
                playerAId={team1Ids[0]} playerBId={team1Ids[1]}
                state={bbState.team1?.[h.number]} onUpdate={(s) => updateBB("team1", h.number, s)}
                onMarkDrive={(who) => markDriveForBB("team1", h, who, bbState.team1?.[h.number], who === "A" ? pA1?.name : pB1?.name)}
                onMarkShot={(who, roundIdx) => markNextShotForBB("team1", h, who, roundIdx, who === "A" ? pA1?.name : pB1?.name)}
                livePos={livePos} distanceUnit={distanceUnit} mePlayerId={mePlayerId} meBag={mePlayer?.bag} />
              {!solo && (
                <BetterBallHoleCard hole={h} teamKey="team2" teamColor={C.team2} teamLabel="Team 2" playerAName={pA2?.name || "A"} playerBName={pB2?.name || "B"}
                  playerAId={team2Ids[0]} playerBId={team2Ids[1]}
                  state={bbState.team2?.[h.number]} onUpdate={(s) => updateBB("team2", h.number, s)}
                  onMarkDrive={(who) => markDriveForBB("team2", h, who, bbState.team2?.[h.number], who === "A" ? pA2?.name : pB2?.name)}
                  onMarkShot={(who, roundIdx) => markNextShotForBB("team2", h, who, roundIdx, who === "A" ? pA2?.name : pB2?.name)}
                  livePos={livePos} distanceUnit={distanceUnit} mePlayerId={mePlayerId} meBag={mePlayer?.bag} />
              )}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16, textAlign: "right" }}>
        <button style={btnPrimary} onClick={finishBetterBallRound}>Finish & save round</button>
      </div>
      {driveModal && (
        <DriveMapModal
          hole={driveModal.hole}
          label={driveModal.label}
          shotLabel={driveModal.shotLabel}
          fromLat={driveModal.fromLat}
          fromLon={driveModal.fromLon}
          initialPos={driveModal.initialPos}
          distanceUnit={distanceUnit}
          onCancel={() => setDriveModal(null)}
          onSave={driveModal.onSave}
        />
      )}
      {shotDetector.fired && myPending && !driveModal && (
        <ShotStopPrompt
          hole={myPending.hole}
          onDismiss={() => shotDetector.reset()}
          onMark={() => { if (shotDetector.stoppedAt) openAutoShotModal(myPending, shotDetector.stoppedAt); }}
        />
      )}
    </div>
  );
}

/* ================= ROUND DETAIL COMPONENTS ================= */
function ShotChip({ label, colorKey }) {
  const color = colorKey ? SHAPE_COLOR[colorKey] : C.line;
  return (
    <span style={{
      display: "inline-block", padding: "2px 7px", margin: "1px 3px 1px 0", borderRadius: 4,
      fontSize: 11, fontFamily: sans, fontWeight: 700, color: colorKey ? C.white : C.ink, background: color,
    }}>
      {label}
    </span>
  );
}

function RoundDetailStroke({ round, players, courseHoles, distanceUnit }) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {round.playerIds.map((pid) => {
        const player = players.find((p) => p.id === pid);
        const s = round.scores[pid];
        const stats = computeRoundStats(round, pid, courseHoles);
        const pieData = [
          { name: "Fairway", value: stats.shapeCounts.fairway || 0 },
          { name: "Left", value: stats.shapeCounts.left || 0 },
          { name: "Right", value: stats.shapeCounts.right || 0 },
        ].filter((d) => d.value > 0);
        const pieColors = { Fairway: C.turf, Left: C.flag, Right: C.brass };
        return (
          <div key={pid} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: 12 }}>
            <div style={{ fontFamily: serif, fontSize: 15, color: C.fairway, marginBottom: 8 }}>{player?.name || "?"}</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", fontFamily: mono, fontSize: 12, width: "100%" }}>
                <thead><tr><th style={thStyle}>Hole</th><th style={thStyle}>Par</th><th style={thStyle}>Score</th><th style={thStyle}>Putts</th><th style={thStyle}>Drive</th><th style={thStyle}>Club</th><th style={thStyle}>Other shots</th></tr></thead>
                <tbody>
                  {Object.keys(s?.holes || {}).map((hn) => {
                    const cell = s.holes[hn];
                    const hPar = courseHoles.find((h) => String(h.number) === String(hn))?.par;
                    const extraShots = cell.extraShots || [];
                    return (
                      <tr key={hn}>
                        <td style={tdStyle}>{hn}</td>
                        <td style={tdStyle}>{hPar ?? "—"}</td>
                        <td style={tdStyle}><ScoreBadge gross={cell.gross} par={hPar} /></td>
                        <td style={tdStyle}>{cell.putts || "—"}</td>
                        <td style={tdStyle}>{cell.driveYards ? `${Math.round(displayDistance(cell.driveYards, distanceUnit))}${distanceUnit === "m" ? "m" : "y"}` : "—"}</td>
                        <td style={tdStyle}>{cell.club || "—"}</td>
                        <td style={tdStyle}>
                          {extraShots.length === 0 ? "—" : extraShots.map((es, i) => (
                            <div key={i} style={{ whiteSpace: "nowrap" }}>
                              S{i + 2}: {es.yards != null ? `${Math.round(displayDistance(es.yards, distanceUnit))}${distanceUnit === "m" ? "m" : "y"}` : "—"}{es.club ? ` (${es.club})` : ""}
                            </div>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ fontFamily: sans, fontSize: 12, color: C.ink, marginTop: 10, lineHeight: 1.7 }}>
              Gross <b>{s?.gross}</b> · Net <b>{s?.net}</b> (CH {s?.courseHandicap}) · Putts <b>{stats.totalPutts || "—"}</b>
              {stats.fir != null && <> · FIR <b>{stats.fir}%</b> ({stats.firHit}/{stats.firAttempts})</>}
              {stats.gir != null && <> · GIR <b>{stats.gir}%</b> ({stats.girHit}/{stats.girAttempts})</>}
            </div>
            {pieData.length > 0 && (
              <div style={{ width: "100%", height: 190, marginTop: 6 }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" outerRadius={65} label={(d) => `${d.name} ${d.value}`}>
                      {pieData.map((entry, i) => <Cell key={i} fill={pieColors[entry.name]} />)}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RoundDetailBetterBall({ round, players, distanceUnit }) {
  return (
    <div style={{ display: "grid", gap: 18 }}>
      {round.teams.map((team, ti) => {
        const pA = players.find((p) => p.id === team.playerIds[0]);
        const pB = players.find((p) => p.id === team.playerIds[1]);
        const color = ti === 0 ? C.team1 : C.team2;
        return (
          <div key={ti}>
            <div style={{ fontFamily: serif, fontSize: 15, color, marginBottom: 6 }}>
              {team.name} — {pA?.name} & {pB?.name} — Total <b>{team.total}</b>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", fontFamily: mono, fontSize: 12, width: "100%" }}>
                <thead><tr><th style={thStyle}>Hole</th><th style={thStyle}>Shots played from</th><th style={thStyle}>Putts</th><th style={thStyle}>Score</th></tr></thead>
                <tbody>
                  {Object.keys(team.holeScores).map((hn) => {
                    const detail = team.holeDetails?.[hn];
                    const putts = detail?.puttMode === "better" ? detail.betterPutts
                      : detail?.puttMode === "own" ? Math.min(Number(detail.ownPutts?.A) || 99, Number(detail.ownPutts?.B) || 99)
                      : null;
                    return (
                      <tr key={hn}>
                        <td style={tdStyle}>{hn}</td>
                        <td style={tdStyle}>
                          {detail?.rounds?.map((rnd, ri) => {
                            const who = rnd.continueWith === "A" ? (pA?.name || "A") : rnd.continueWith === "B" ? (pB?.name || "B") : "—";
                            let shape = null, driveYd = null, club = null;
                            if (ri === 0) {
                              shape = rnd.continueWith === "A" ? rnd.shapeA : rnd.continueWith === "B" ? rnd.shapeB : null;
                              driveYd = rnd.continueWith === "A" ? rnd.driveYardsA : rnd.continueWith === "B" ? rnd.driveYardsB : null;
                              club = rnd.continueWith === "A" ? rnd.clubA : rnd.continueWith === "B" ? rnd.clubB : null;
                            } else {
                              driveYd = rnd.shotYards ?? null;
                              club = rnd.club ?? null;
                            }
                            const extra = [club, driveYd ? `${Math.round(displayDistance(driveYd, distanceUnit))}${distanceUnit === "m" ? "m" : "y"}` : null].filter(Boolean).join(", ");
                            const label = extra ? `${who} (${extra})` : who;
                            return <ShotChip key={ri} label={label} colorKey={shape} />;
                          })}
                        </td>
                        <td style={tdStyle}>{putts ?? "—"}</td>
                        <td style={tdStyle}>{team.holeScores[hn] ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ fontFamily: sans, fontSize: 11, color: C.turf, marginTop: 4 }}>
              Chip color: <span style={{ color: C.turf, fontWeight: 700 }}>green = fairway/on green</span>, <span style={{ color: C.flag, fontWeight: 700 }}>red = left</span>, <span style={{ color: C.brass, fontWeight: 700 }}>amber = right</span> (based on that hole's drive)
            </div>
          </div>
        );
      })}
    </div>
  );
}


function HistoryTab({ rounds, players, courses, distanceUnit }) {
  const [open, setOpen] = useState(null);
  if (rounds.length === 0) return <div style={emptyStyle}>No rounds recorded yet. Play a round to see it here.</div>;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {rounds.map((r) => {
        const isOpen = open === r.id;
        const isBB = r.format === "betterball";
        const course = courses.find((c) => c.id === r.courseId);
        return (
          <div key={r.id} style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", cursor: "pointer" }} onClick={() => setOpen(isOpen ? null : r.id)}>
              <div style={{ fontFamily: serif, fontSize: 16, color: C.fairway }}>{r.courseName} {isBB && <span style={{ fontSize: 11, color: C.brass, fontFamily: sans }}>· Better Ball</span>}</div>
              <div style={{ fontFamily: mono, fontSize: 13, color: C.turf }}>{r.date}</div>
            </div>
            <div style={{ fontFamily: sans, fontSize: 12, color: C.turf, marginTop: 4 }}>
              {isBB
                ? r.teams.map((t) => `${t.name} (${t.playerIds.map((pid) => players.find((p) => p.id === pid)?.name || "?").join(" & ")}): ${t.total}`).join("  ·  ")
                : r.playerIds.map((pid) => {
                    const p = players.find((x) => x.id === pid);
                    const s = r.scores[pid];
                    return `${p?.name || "?"}: ${s?.gross ?? "—"} gross / ${s?.net ?? "—"} net`;
                  }).join("  ·  ")}
            </div>
            {isOpen && (
              <div style={{ marginTop: 10, borderTop: `1px solid ${C.line}`, paddingTop: 10 }}>
                {isBB
                  ? <RoundDetailBetterBall round={r} players={players} distanceUnit={distanceUnit} />
                  : <RoundDetailStroke round={r} players={players} courseHoles={course?.holes || []} distanceUnit={distanceUnit} />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ================= APP ================= */
export default function App() {
  const [tab, setTab] = useState("play");
  const [courses, setCoursesState] = useState([]);
  const [players, setPlayersState] = useState([]);
  const [rounds, setRoundsState] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [location, setLocation] = useState(null);
  const [distanceUnit, setDistanceUnitState] = useState("yd");
  const [voiceWakeWord, setVoiceWakeWordState] = useState("");
  const [mePlayerId, setMePlayerIdState] = useState(null);

  useEffect(() => {
    setCoursesState(loadKey("golf:courses", []));
    setPlayersState(loadKey("golf:players", []));
    setRoundsState(loadKey("golf:rounds", []));
    const settings = loadKey("golf:settings", { distanceUnit: "yd", voiceWakeWord: "" });
    setDistanceUnitState(settings?.distanceUnit === "m" ? "m" : "yd");
    setVoiceWakeWordState(typeof settings?.voiceWakeWord === "string" ? settings.voiceWakeWord : "");
    setMePlayerIdState(loadKey("golf:mePlayerId", null));
    setLoaded(true);
  }, []);

  /* both settings live in the one "golf:settings" object — always read-merge-write so toggling
     one (e.g. the yd/m switch) can never silently wipe out the other */
  const setDistanceUnit = useCallback((u) => {
    setDistanceUnitState(u);
    saveKey("golf:settings", { ...loadKey("golf:settings", {}), distanceUnit: u });
  }, []);
  const setVoiceWakeWord = useCallback((w) => {
    setVoiceWakeWordState(w);
    saveKey("golf:settings", { ...loadKey("golf:settings", {}), voiceWakeWord: w });
  }, []);
  const setMePlayerId = useCallback((id) => { setMePlayerIdState(id); saveKey("golf:mePlayerId", id); }, []);

  const setCourses = useCallback((next) => { setCoursesState(next); saveKey("golf:courses", next); }, []);
  const setPlayers = useCallback((next) => { setPlayersState(next); saveKey("golf:players", next); }, []);
  const setRounds = useCallback((next) => { setRoundsState(next); saveKey("golf:rounds", next); }, []);

  const requestLocation = useCallback(() => {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(null); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => { const loc = { lat: pos.coords.latitude, lon: pos.coords.longitude }; setLocation(loc); resolve(loc); },
        () => resolve(null)
      );
    });
  }, []);

  if (!loaded) {
    return <div style={{ padding: 40, fontFamily: sans, color: C.turf }}>Loading…</div>;
  }

  return (
    <div style={{ minHeight: "100vh", background: C.paper, fontFamily: sans }}>
      <div style={{ background: C.fairway, padding: "16px 14px 0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, gap: 8 }}>
          <div style={{ fontFamily: serif, fontSize: 22, color: C.white }}>Linksman</div>
          <div style={{ display: "flex", gap: 2, background: "rgba(251,249,242,0.12)", borderRadius: 5, padding: 2, flexShrink: 0 }}>
            {["yd", "m"].map((u) => (
              <button key={u} onClick={() => setDistanceUnit(u)}
                style={{
                  fontFamily: sans, fontSize: 11, fontWeight: 700, padding: "4px 9px", borderRadius: 4, border: "none", cursor: "pointer",
                  background: distanceUnit === u ? C.brass : "transparent",
                  color: distanceUnit === u ? C.fairwayDark : "rgba(251,249,242,0.7)",
                }}>
                {u === "yd" ? "Yd" : "M"}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex" }}>
          <Tab label="Play" active={tab === "play"} onClick={() => setTab("play")} />
          <Tab label="Courses" active={tab === "courses"} onClick={() => setTab("courses")} />
          <Tab label="Players" active={tab === "players"} onClick={() => setTab("players")} />
          <Tab label="History" active={tab === "history"} onClick={() => setTab("history")} />
        </div>
      </div>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "22px 20px 60px" }}>
        {tab === "play" && <PlayTab courses={courses} players={players} setPlayers={setPlayers} rounds={rounds} setRounds={setRounds} distanceUnit={distanceUnit} mePlayerId={mePlayerId} voiceWakeWord={voiceWakeWord} />}
        {tab === "courses" && <CoursesTab courses={courses} setCourses={setCourses} location={location} requestLocation={requestLocation} distanceUnit={distanceUnit} />}
        {tab === "players" && <PlayersTab players={players} setPlayers={setPlayers} distanceUnit={distanceUnit} mePlayerId={mePlayerId} setMePlayerId={setMePlayerId} voiceWakeWord={voiceWakeWord} setVoiceWakeWord={setVoiceWakeWord} />}
        {tab === "history" && <HistoryTab rounds={rounds} players={players} courses={courses} distanceUnit={distanceUnit} />}
      </div>
    </div>
  );
}
