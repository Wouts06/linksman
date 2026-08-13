import React, { useState, useEffect, useMemo, useCallback, useRef, useId } from "react";
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

/* live device compass heading, 0-360° clockwise from true/magnetic north — powers the wind
   indicator's "rotate as the phone turns" behavior. Two very different platform APIs:
   - iOS 13+ Safari: DeviceOrientationEvent.requestPermission() must be called from a user
     gesture before any orientation events fire at all; once granted, events carry a ready-to-use
     `webkitCompassHeading` (already a true-north compass bearing, no math needed).
   - Everyone else (Android Chrome, etc.): no JS-triggerable permission gate — events just fire
     (assuming the browser/OS-level motion-sensor permission is allowed). The dedicated
     'deviceorientationabsolute' event (or a plain 'deviceorientation' event with `absolute:
     true`) carries `alpha`, which increases counter-clockwise from the device's start position;
     converting to a compass bearing is `(360 - alpha) % 360`.
   **Fixed 11 Aug — real-device bug**: this originally only accepted `alpha` when the event was
   genuinely flagged absolute (`e.absolute === true` or a 'deviceorientationabsolute' event). A
   large, well-documented chunk of Android/Chrome devices — across many manufacturers, not one
   specific model — never fire a properly-flagged absolute event at all, even though the plain
   'deviceorientation' event's `alpha` is, in practice, still magnetometer-referenced on those
   devices. The strict check silently discarded every event on those devices, so `heading` never
   left `null` and the dial never rotated — indistinguishable, from the user's side, from the
   compass being broken. Now falls back to trusting plain (non-absolute) `alpha` values *until* a
   genuinely-absolute event shows up, at which point it switches over to the more trustworthy
   source and stops trusting the relative one.
   Known limitation: this doesn't compensate for screen rotation (landscape use) — fine for a
   golf app used portrait-in-hand, but heading would read off by 90°/180° in landscape. */
function useCompassHeading(active) {
  const [heading, setHeading] = useState(null);
  const [signal, setSignal] = useState("waiting"); // "waiting" | "receiving" | "stalled" — "stalled" surfaces a hint that no orientation events arrived at all (a different, deeper problem than the absolute-flag bug above)
  const [diagnostic, setDiagnostic] = useState(null); // extra info gathered once "stalled", to make the hint actionable instead of a dead end — see note below
  const needsIOSPermission = typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function";
  const [permission, setPermission] = useState(needsIOSPermission ? "prompt" : "granted");
  const gotAbsoluteRef = useRef(false);
  const gotAnyEventRef = useRef(false);

  // Real-world report (11 Aug, Samsung Galaxy S24 FE): the "stalled" hint above fired with truly
  // zero usable orientation events reaching the page — a different, deeper problem than the
  // absolute-flag bug this hook already works around. Chrome for Android doesn't gate
  // deviceorientation behind a JS-visible permission prompt the way iOS Safari does, so a silent
  // failure here can mean several very different things: (1) the browser isn't actually Chrome —
  // Samsung phones often route links through Samsung Internet even when the user thinks they're
  // "in Chrome" (share-sheet/notification links, or Samsung Internet set as the default handler);
  // (2) Chrome's per-site "Motion sensors" permission (chrome://settings/content/sensors, or the
  // site info/padlock icon → Permissions) is set to Block; (3) some Samsung One UI phones have a
  // system-wide Quick Panel "Sensors off" toggle that silently kills motion data for every app,
  // browser included. `navigator.permissions.query` for "accelerometer"/"magnetometer" is
  // Chrome-supported and can at least confirm case (2) directly instead of guessing.
  const isSamsungBrowser = typeof navigator !== "undefined" && /SamsungBrowser/i.test(navigator.userAgent || "");

  useEffect(() => {
    if (!active || permission !== "granted" || typeof window === "undefined") return;
    gotAbsoluteRef.current = false;
    gotAnyEventRef.current = false;
    setSignal("waiting");
    setDiagnostic(null);
    function handle(e) {
      let h = null;
      if (e.webkitCompassHeading != null) {
        h = e.webkitCompassHeading;
      } else if (e.alpha != null) {
        const isAbsoluteEvent = e.absolute === true || e.type === "deviceorientationabsolute";
        if (isAbsoluteEvent) {
          gotAbsoluteRef.current = true;
          h = (360 - e.alpha) % 360;
        } else if (!gotAbsoluteRef.current) {
          // fallback for devices that never send a genuinely-absolute event — see comment above
          h = (360 - e.alpha) % 360;
        }
      }
      // only counts as "signal" once we actually have a usable heading — some browsers (notably
      // headless/synthetic test environments, but plausibly some real ones too) fire an initial
      // orientation event with no alpha at all just to announce the API exists, which shouldn't
      // count as "the compass is working"
      if (h != null && !Number.isNaN(h)) {
        gotAnyEventRef.current = true;
        setSignal("receiving");
        setHeading(h);
      }
    }
    window.addEventListener("deviceorientationabsolute", handle, true);
    window.addEventListener("deviceorientation", handle, true);
    const stalledTimer = setTimeout(() => {
      if (gotAnyEventRef.current) return;
      setSignal("stalled");
      // best-effort: query() can throw/reject on browsers that don't recognize these permission
      // names at all (not just Chrome variants) — swallow and just skip the extra diagnostic
      Promise.all([
        navigator.permissions?.query?.({ name: "accelerometer" }).catch(() => null),
        navigator.permissions?.query?.({ name: "magnetometer" }).catch(() => null),
      ]).then(([accel, mag]) => {
        if (accel?.state === "denied" || mag?.state === "denied") setDiagnostic("permission-denied");
      }).catch(() => {});
    }, 5000);
    return () => {
      window.removeEventListener("deviceorientationabsolute", handle, true);
      window.removeEventListener("deviceorientation", handle, true);
      clearTimeout(stalledTimer);
    };
  }, [active, permission]);

  const requestPermission = useCallback(async () => {
    if (!needsIOSPermission) { setPermission("granted"); return; }
    try {
      const result = await DeviceOrientationEvent.requestPermission();
      setPermission(result === "granted" ? "granted" : "denied");
    } catch {
      setPermission("denied");
    }
  }, [needsIOSPermission]);

  return { heading, permission, needsIOSPermission, requestPermission, signal, diagnostic, isSamsungBrowser };
}

/* ---------- golf bag / club suggestion / voice caddy ---------- */
const CLUBS = ["Driver", "3 Wood", "5 Wood", "3 Hybrid", "4 Hybrid", "3 Iron", "4 Iron", "5 Iron", "6 Iron", "7 Iron", "8 Iron", "9 Iron", "PW", "GW", "SW", "LW", "Putter"];

/* Short display labels for the golf bag checklist ONLY — purely cosmetic, to keep that list
   compact on narrow screens. The canonical club name (CLUBS, above) is still what's stored,
   matched against CLUB_ALIASES for voice recognition, and shown everywhere else (scoring,
   history) — abbreviating here doesn't change what the voice caddy understands or what gets
   saved; "Hey Gaddy, 7 iron" still resolves to the same club whether its bag checkbox reads
   "7 Iron" or "7i". */
const CLUB_ABBREV = {
  "Driver": "Dr", "3 Wood": "3w", "5 Wood": "5w", "3 Hybrid": "3h", "4 Hybrid": "4h",
  "3 Iron": "3i", "4 Iron": "4i", "5 Iron": "5i", "6 Iron": "6i", "7 Iron": "7i", "8 Iron": "8i", "9 Iron": "9i",
  "PW": "PW", "GW": "GW", "SW": "SW", "LW": "LW", "Putter": "Pt",
};

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

/* ---------- wind indicator ---------- */
const COMPASS_POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
function compassPointFromDegrees(deg) {
  if (deg == null) return "";
  return COMPASS_POINTS[Math.round(deg / 22.5) % 16];
}

/* live wind speed/gust/direction for a fixed lat/lon, via our own /api/wind proxy (mirrors the
   osm-* proxies — same reasoning: browser fetch() can't set a User-Agent, and it's one less
   external-API assumption to leave unverified after the OSM Nominatim/Overpass lesson earlier
   in this project). Refetches on an interval rather than reacting to every GPS update — wind
   barely changes hole to hole, and the underlying model itself only updates ~every 15 minutes,
   so there's nothing to gain from fetching more often than a golfer plays a few holes. */
function useWindData(lat, lon, unit) {
  const [state, setState] = useState({ speed: null, gust: null, direction: null, loading: false, error: null });
  useEffect(() => {
    if (lat == null || lon == null) return;
    let cancelled = false;
    async function load() {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const url = `/api/wind?lat=${lat}&lon=${lon}&unit=${unit === "kmh" ? "kmh" : "mph"}`;
        const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, 10000);
        if (!res.ok) throw new Error("Wind lookup failed");
        const data = await res.json();
        const c = data.current || {};
        if (!cancelled) {
          setState({
            speed: c.wind_speed_10m ?? null,
            gust: c.wind_gusts_10m ?? null,
            direction: c.wind_direction_10m ?? null,
            loading: false, error: null,
          });
        }
      } catch {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: "Couldn't load wind data" }));
      }
    }
    load();
    const id = setInterval(load, 10 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [lat, lon, unit]);
  return state;
}

/* compass-rose dial: rotates the whole face (N/E/S/W ticks + wind arrow together) by
   -deviceHeading so it stays locked to the real world as the phone turns, the same way a
   physical compass does — a fixed triangle at the top marks "the way your phone is pointing."
   The arrow is drawn pointing DOWNWIND (the direction the wind is blowing TOWARD, wind-sock/
   flag style — how golfers already read wind on a course) rather than the meteorological
   "from" direction used in the text label next to it.
   Redesigned smaller and more minimal (13 Aug, at the user's request after a real round) — the
   N/E/S/W letters are gone (replaced by short tick marks, which don't need the extra radius
   text legibility required, letting the whole dial shrink) and the face/arrow use gradients
   plus a drop-shadow filter for a subtle raised "3D" look instead of a flat 2D pointer, while
   keeping the exact same live-rotation behavior that made the original version clear to read. */
function WindDial({ windDirection, heading, hasCompass, size }) {
  const r = size / 2;
  const toward = windDirection != null ? (windDirection + 180) % 360 : null;
  const roseRotation = hasCompass ? -heading : 0;
  const uid = useId();
  const faceGrad = `wind-face-${uid}`, arrowGrad = `wind-arrow-${uid}`, arrowShadow = `wind-shadow-${uid}`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <defs>
        {/* subtle dome/bevel on the face — lighter at top-left, darker at bottom-right */}
        <radialGradient id={faceGrad} cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor={C.white} />
          <stop offset="100%" stopColor={C.paper2} />
        </radialGradient>
        {/* glossy fill on the arrow itself, brightest near the tip */}
        <linearGradient id={arrowGrad} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#D65A4C" />
          <stop offset="100%" stopColor={C.flag} />
        </linearGradient>
        <filter id={arrowShadow} x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="1" stdDeviation="1" floodColor={C.fairwayDark} floodOpacity="0.35" />
        </filter>
      </defs>
      <g style={{ transform: `rotate(${roseRotation}deg)`, transformOrigin: `${r}px ${r}px`, transition: "transform 0.15s linear" }}>
        <circle cx={r} cy={r} r={r - 2} fill={`url(#${faceGrad})`} stroke={C.fairway} strokeWidth={1.25} />
        {/* short reference ticks at N/E/S/W stand in for the old letter labels — same four
            reference points, no text-legibility radius required, so the dial can be smaller */}
        {[0, 90, 180, 270].map((deg) => {
          const rad = (deg * Math.PI) / 180;
          const outer = r - 2.5, inner = deg === 0 ? r - 7 : r - 5.5;
          return (
            <line
              key={deg}
              x1={r + Math.sin(rad) * inner} y1={r - Math.cos(rad) * inner}
              x2={r + Math.sin(rad) * outer} y2={r - Math.cos(rad) * outer}
              stroke={C.turf} strokeWidth={deg === 0 ? 1.75 : 1.25} strokeLinecap="round"
            />
          );
        })}
        {toward != null && (
          <g style={{ transform: `rotate(${toward}deg)`, transformOrigin: `${r}px ${r}px` }} filter={`url(#${arrowShadow})`}>
            {/* solid gradient-filled needle, center out to the tip — a triangular head tapering
                into a narrow shaft, rather than the old thin stroked line + separate polygon */}
            <path
              d={`M ${r} ${r * 0.22}
                  L ${r + r * 0.17} ${r * 0.58} L ${r + r * 0.055} ${r * 0.58} L ${r + r * 0.055} ${r}
                  L ${r - r * 0.055} ${r} L ${r - r * 0.055} ${r * 0.58} L ${r - r * 0.17} ${r * 0.58} Z`}
              fill={`url(#${arrowGrad})`}
            />
          </g>
        )}
        <circle cx={r} cy={r} r={2} fill={C.fairway} />
      </g>
      <polygon points={`${r - 3.5},2 ${r + 3.5},2 ${r},8`} fill={C.ink} />
    </svg>
  );
}

/* the wind panel shown above the scorecard while actively scoring — dial + speed/gust text +,
   on iOS only, a one-tap "enable compass" prompt (see useCompassHeading). Renders nothing when
   there's no location to look wind up for, or the lookup hasn't returned anything yet, rather
   than cluttering the scoring screen with a loading/error state for an optional feature. */
function WindIndicator({ wind, compass, unit }) {
  if (wind.speed == null) return null;
  const unitLabel = unit === "kmh" ? "km/h" : "mph";
  const hasCompass = compass.heading != null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 10px", background: C.white, width: "100%", boxSizing: "border-box" }}>
      {/* dial shrunk from 60→44px (13 Aug) — the redesigned arrow/ticks (see WindDial) don't
          need the old letter-label radius, so the panel reads just as clearly at this size
          while taking noticeably less vertical room */}
      <WindDial windDirection={wind.direction} heading={compass.heading || 0} hasCompass={hasCompass} size={44} />
      <div style={{ flex: 1, minWidth: 0, fontFamily: sans }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>
          {Math.round(wind.speed)} {unitLabel}
          {wind.direction != null && <span style={{ color: C.turf, fontWeight: 400 }}> from {compassPointFromDegrees(wind.direction)}</span>}
        </div>
        {wind.gust != null && (
          <div style={{ fontSize: 12, color: C.flag, fontWeight: 600 }}>Gusts to {Math.round(wind.gust)} {unitLabel}</div>
        )}
        {compass.permission === "prompt" && (
          <button style={{ ...btnGhost, fontSize: 10, padding: "3px 7px", marginTop: 4 }} onClick={compass.requestPermission}>🧭 Enable live compass</button>
        )}
        {compass.permission === "denied" && (
          <div style={{ fontSize: 10, color: C.turf, marginTop: 3 }}>Compass permission denied — arrow shown relative to true north.</div>
        )}
        {compass.permission === "granted" && compass.signal === "stalled" && (
          <div style={{ fontSize: 10, color: C.turf, marginTop: 3, lineHeight: 1.5 }}>
            No compass signal — dial won't rotate as you turn.{" "}
            {compass.isSamsungBrowser ? (
              "This looks like Samsung Internet rather than Chrome — try opening this site in Chrome instead."
            ) : compass.diagnostic === "permission-denied" ? (
              "Motion sensors look blocked for this site — tap the site info (ⓘ or padlock) icon in the address bar → Permissions → Motion sensors, and allow it."
            ) : (
              "On Samsung phones, check the Quick Panel for a \"Sensors off\" toggle (turn it off), and make sure you're opening this in Chrome, not Samsung Internet."
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* how much real data a parsed hole carries — used to pick a winner when the same hole number
   shows up more than once (see dedup note in parseOSMHoleElements below) */
function holeCompleteness(h) {
  return [h.par, h.strokeIndex, h.yardageMeters, h.teeLat, h.greenLat].filter((v) => v != null).length;
}

/* Splits the raw Overpass response into (1) `golf=hole` ways — the existing per-hole
   par/distance/tee-green geometry — and (2) `golf=tee` points/areas — individual tee-box
   markers, some of which OpenStreetMap mappers colour-tag via `tee=<colour>` (e.g. `tee=red`;
   see the OSM wiki's Tag:golf=tee page) to indicate which physical tee-box that marker is.
   `api/osm-holes.js` fetches both kinds of element in the same query (13 Aug, tee-box
   OSM-detection round) — this function is what actually tells them apart, since both element
   kinds mix together in one flat `elements` array. */
function parseOSMHoleElements(data) {
  const elements = data.elements || [];

  const holeWays = elements.filter((el) => (el.tags || {}).golf === "hole");
  const parsed = holeWays
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
    .filter((h) => h.number != null && !isNaN(h.number));

  // A bounding-box (or, occasionally, an area) query can pick up `golf=hole` ways belonging to
  // a different, geographically close course that happens to number its holes the same way —
  // seen in practice as a course reporting double (or a handful extra) the holes it actually
  // has. Dedupe by hole number, keeping whichever candidate has more real data, so a stray
  // duplicate never inflates the hole count or silently overwrites a fully-mapped hole with a
  // bare one.
  const byNumber = new Map();
  for (const h of parsed) {
    const existing = byNumber.get(h.number);
    if (!existing || holeCompleteness(h) > holeCompleteness(existing)) byNumber.set(h.number, h);
  }
  const holes = [...byNumber.values()].sort((a, b) => a.number - b.number);

  // golf=tee elements: a node has lat/lon directly; an area (way/multipolygon) is returned as
  // a geometry ring by `out geom`, so its center is approximated as the average of its
  // vertices — plenty precise for "which tee box is this," not meant to be exact-centroid.
  //
  // REAL-WORLD TAGGING, confirmed 13 Aug by querying two actual mapped courses directly (one a
  // random well-known course, one the app's own user's course, hand-verified against what he
  // knew he'd mapped) — both wiki-documented conventions this originally assumed turned out to
  // not hold in practice:
  // (1) `ref=*` (the wiki's documented way to associate a tee marker with its hole number) is
  //     essentially never present on real golf=tee elements, even on richly-mapped courses.
  //     Every real course checked instead relies on **spatial proximity** — a tee marker simply
  //     sits near its own hole's start and nowhere near any other hole's. So hole association is
  //     now done by nearest-hole-by-tee-point matching (`nearestHoleNumber`, below) against the
  //     golf=hole ways already parsed above, falling back to an explicit `ref` first in case a
  //     future/other course's mapper *does* tag it (costs nothing to prefer it when present).
  // (2) `tee=*` is very commonly a **semicolon-separated list**, e.g. `tee=white;blue` — one
  //     physical tee-box shape shared by two (or three) color markers sitting on the same pad,
  //     not one color per element. Each color in the list needs its own tee-set entry sharing
  //     that box's location (and any per-color distance below), not one combined "white;blue"
  //     pseudo-color (which wouldn't match any preset and would be meaningless to a player).
  // (3) Some mappers (seen on the course with `source: coct-2015` tags) add authoritative
  //     `dist:<colour>=<value>` tags with their own real-world-measured yardage for that specific
  //     color (usually in meters, e.g. `"dist:red":"287meters"`, occasionally missing the unit
  //     suffix or with a typo like "maters") — strictly better than our own tee-point-to-green
  //     haversine estimate when present, so it's extracted here and preferred in buildOSMTeeSets.
  const rawTeeElements = elements.filter((el) => (el.tags || {}).golf === "tee");
  const teeBoxes = rawTeeElements
    .flatMap((el) => {
      const tags = el.tags || {};
      if (!tags.tee) return [];
      const geom = el.geometry || [];
      let lat = el.lat, lon = el.lon;
      if (lat == null && geom.length) {
        lat = geom.reduce((s, p) => s + p.lat, 0) / geom.length;
        lon = geom.reduce((s, p) => s + p.lon, 0) / geom.length;
      }
      if (lat == null || lon == null) return [];
      const explicitNumber = tags.ref ? Number(tags.ref) : null;
      const number = explicitNumber != null && !isNaN(explicitNumber) ? explicitNumber : nearestHoleNumber(lat, lon, holes);
      if (number == null) return [];
      const colors = String(tags.tee).split(";").map((c) => c.trim()).filter(Boolean);
      const distKeys = Object.keys(tags).filter((k) => k.toLowerCase().startsWith("dist:"));
      return colors.map((color) => {
        const distKey = distKeys.find((k) => k.slice(5).toLowerCase() === color.toLowerCase());
        const rawDist = distKey ? tags[distKey] : null;
        const distMeters = rawDist != null ? parseFloat(String(rawDist).replace(/[^0-9.]/g, "")) : NaN;
        return { number, color, lat, lon, distMeters: isNaN(distMeters) ? null : distMeters };
      });
    });

  return { holes, teeBoxes };
}

/* real golf=tee elements essentially never carry a hole-number tag in practice (see the note
   above parseOSMHoleElements's teeBoxes) — this finds whichever hole's own tee point (already
   parsed from its golf=hole way, see `holes` above) is physically closest to a tee marker's own
   position, which is how a human would identify "whose tee box is this" too. Returns null if no
   hole in this course has a usable tee point to compare against (e.g. no golf=hole ways at all). */
function nearestHoleNumber(lat, lon, holes) {
  let best = null, bestDist = Infinity;
  for (const h of holes) {
    if (h.teeLat == null || h.teeLon == null) continue;
    const d = haversineMeters(lat, lon, h.teeLat, h.teeLon);
    if (d < bestDist) { bestDist = d; best = h.number; }
  }
  return best;
}

/* Groups raw golf=tee markers (see parseOSMHoleElements) into named tee sets — one per
   distinct `tee=*` tag value found, each carrying its own per-hole yardage (computed from that
   specific tee marker's real GPS position to the hole's green, not approximated from the
   golf=hole way) and the marker's own coordinates for live GPS use. A color/designation only
   showing up on some holes is fine — getTeeHole() already falls back to the course's base hole
   data for any hole a given tee set doesn't cover (e.g. partial mapping coverage). Sorted by
   how many holes each tee actually covers (most-complete first) — CoursesTab uses this order
   to decide which detected tee, if any, upgrades the primary/default table (see applyOSMHoles). */
function buildOSMTeeSets(holes, teeBoxes) {
  const holesByNumber = new Map(holes.map((h) => [h.number, h]));
  const groups = new Map(); // colorKey (lowercased tee=* tag) -> Map(holeNumber -> {lat,lon,distMeters})
  for (const tb of teeBoxes) {
    const key = tb.color.toLowerCase();
    if (!groups.has(key)) groups.set(key, new Map());
    const m = groups.get(key);
    if (!m.has(tb.number)) m.set(tb.number, { lat: tb.lat, lon: tb.lon, distMeters: tb.distMeters });
  }
  const sets = [];
  for (const [colorKey, ptsByHole] of groups) {
    const info = resolveTeeColor(colorKey);
    const holesObj = {};
    for (const [num, pt] of ptsByHole) {
      const baseHole = holesByNumber.get(num);
      // prefer a mapper-supplied `dist:<colour>` value (real-world-measured, see
      // parseOSMHoleElements) over our own tee-point-to-green estimate when present
      const yardage = pt.distMeters != null
        ? Math.round(pt.distMeters / 0.9144)
        : baseHole?.greenLat != null
          ? Math.round(haversineMeters(pt.lat, pt.lon, baseHole.greenLat, baseHole.greenLon) / 0.9144)
          : null;
      holesObj[num] = { yardage, teeLat: pt.lat, teeLon: pt.lon };
    }
    sets.push({ colorKey, name: info.name, color: info.color, holeCount: ptsByHole.size, holes: holesObj });
  }
  sets.sort((a, b) => b.holeCount - a.holeCount || a.name.localeCompare(b.name));
  return sets;
}

/* throws (rather than silently returning []) when the lookup fails, so the caller can
   tell "this course genuinely has no mapped holes" apart from "the service is down/busy".
   The mirror-fallback logic now lives server-side in api/osm-holes.js — this just calls that
   one same-origin endpoint.
   Pass the full OSM candidate (osmType/osmId + boundingbox), not just the boundingbox — when
   the candidate is a way/relation (i.e. has real mapped geometry, not just a point), the
   server restricts the search to holes within that specific course's own area instead of a
   bounding box, which otherwise can sweep in a nearby course's holes (see api/osm-holes.js). */
async function fetchOSMHoles(candidate) {
  const boundingbox = candidate?.boundingbox;
  if (!boundingbox && !(candidate?.osmType && candidate?.osmId != null)) return { holes: [], teeSets: [] };
  const params = new URLSearchParams();
  if (candidate?.osmType && candidate?.osmId != null) {
    params.set("osmType", candidate.osmType);
    params.set("osmId", String(candidate.osmId));
  }
  if (boundingbox) {
    const [south, north, west, east] = boundingbox;
    params.set("south", south); params.set("north", north); params.set("west", west); params.set("east", east);
  }
  const url = `/api/osm-holes?${params.toString()}`;
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
    const { holes, teeBoxes } = parseOSMHoleElements(data);
    const teeSets = buildOSMTeeSets(holes, teeBoxes);
    return { holes, teeSets };
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

/* ---- tee boxes (added 13 Aug, at the user's request) ----
   Different colored tee boxes play different yardages (and carry their own course
   rating/slope) on the same course — this lets each player in a round pick which tees they're
   playing, rather than the whole group being locked to one shared yardage table.

   Preset color list, per the user's choice — a course's `tees` array picks from these names
   but stores its own color/rating/slope/per-hole yardage, so this is just the manual-entry
   dropdown's option list, not a fixed schema. Gold/Red reuse the app's existing brass/flag
   colors so they stay within the established palette rather than introducing new ones.
   Extended (13 Aug, tee-box OSM-detection round) beyond the original 5 so that a color OSM
   actually reports (see `resolveTeeColor` below) almost always has a matching preset — avoids
   a mismatched/blank primary-tee dropdown when OpenStreetMap's own `tee=<colour>` tagging uses
   a color outside the original Black/Blue/White/Gold/Red set. */
const TEE_PRESETS = [
  { name: "Black", color: "#1A1A1A" },
  { name: "Blue", color: "#2C5AA0" },
  { name: "White", color: "#FBF9F2" },
  { name: "Gold", color: "#A98B4F" },
  { name: "Red", color: "#B23A2E" },
  { name: "Yellow", color: "#D9B44A" },
  { name: "Green", color: "#3C7A45" },
  { name: "Silver", color: "#B8B8B8" },
  { name: "Orange", color: "#CC6A2C" },
];

/* Resolves an OpenStreetMap `tee=*` tag value (e.g. "red", "championship") to a display
   name + color — matches a known preset case-insensitively where possible (covers the
   overwhelming majority of real-world tags: red/white/blue/black/gold/yellow/green/silver/
   orange), and falls back to title-casing the raw tag with a neutral grey for anything else
   (e.g. "championship", "members") so unusual-but-real tagging still shows up as a usable,
   distinctly-labeled tee rather than being silently dropped. */
function resolveTeeColor(rawTag) {
  const key = String(rawTag || "").trim().toLowerCase();
  const preset = TEE_PRESETS.find((p) => p.name.toLowerCase() === key);
  if (preset) return preset;
  const name = key.replace(/\b\w/g, (c) => c.toUpperCase());
  return { name, color: "#8A8A8A" };
}

/* Courses created before this feature (or never given an explicit tee box) have no `tees`
   array at all — rather than migrating every stored course, this synthesizes a single
   "Default" tee from the course's own legacy top-level fields (course.rating/slope and each
   hole's yardage/teeLat/teeLon — note: despite OSM-derived intermediate values being in
   meters, a course's saved `hole.yardage` is always in YARDS, the app's canonical distance
   unit — see displayDistance/ydToM/mToYd), so old and new courses can be read through the
   exact same helper uniformly. Always returns at least one tee. */
function getCourseTees(course) {
  if (course?.tees?.length) return course.tees;
  const holes = {};
  (course?.holes || []).forEach((h) => {
    holes[h.number] = { yardage: h.yardage ?? null, teeLat: h.teeLat ?? null, teeLon: h.teeLon ?? null };
  });
  return [{ id: "__default", name: "Default", color: C.turf, rating: course?.rating ?? null, slope: course?.slope ?? null, holes }];
}

/* per-tee, per-hole yardage (yards) + tee coordinates, with a graceful fallback: if the chosen
   tee exists but happens to have no data for this specific hole (e.g. partial OpenStreetMap
   coverage — some holes' tee markers colour-tagged, others not), falls back to the course's
   own base hole data rather than showing nothing. teeId of null/undefined/unrecognized also
   falls back to the first tee in the list (getCourseTees always returns at least one). */
function getTeeHole(course, teeId, holeNumber) {
  const tees = getCourseTees(course);
  const tee = tees.find((t) => t.id === teeId) || tees[0];
  const fromTee = tee?.holes?.[holeNumber];
  const baseHole = (course?.holes || []).find((h) => h.number === holeNumber);
  return {
    yardage: fromTee?.yardage ?? baseHole?.yardage ?? null,
    teeLat: fromTee?.teeLat ?? baseHole?.teeLat ?? null,
    teeLon: fromTee?.teeLon ?? baseHole?.teeLon ?? null,
  };
}
function teeById(course, teeId) {
  const tees = getCourseTees(course);
  return tees.find((t) => t.id === teeId) || tees[0];
}

/* orders a course's holes starting from the chosen tee (1st or 10th), wrapping around —
   used by the per-hole stroke-play scoring view so "starting hole" just rotates play order */
function playOrderHoles(holes, startNumber) {
  const sorted = (holes || []).slice().sort((a, b) => a.number - b.number);
  const startIdx = sorted.findIndex((h) => h.number === startNumber);
  if (startIdx <= 0) return sorted;
  return [...sorted.slice(startIdx), ...sorted.slice(0, startIdx)];
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

/* minimalist silhouette mic icon (capsule + stand + base) — replaces the old 🎙️ emoji glyph,
   which also sidesteps the emoji-glyph-height cross-device inconsistency documented on
   headerActionBtnStyle's old comment, since an SVG renders at an exact, consistent size. */
function MicIcon({ size = 18, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <rect x="9" y="2" width="6" height="12" rx="3" fill={color} />
      <path d="M5 11a7 7 0 0 0 14 0" stroke={color} strokeWidth="2" strokeLinecap="round" fill="none" />
      <line x1="12" y1="18" x2="12" y2="21.5" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <line x1="8" y1="21.5" x2="16" y2="21.5" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/* redesigned 13 Aug, at the user's request: a minimalist mic silhouette with the configured
   caddy wake-word name shown below it, rather than emoji + "Voice caddy"/"Listening…" text —
   and sized to match the wind panel's height exactly (both are stretched to the same row
   height by the flex row that renders them side by side — see the `alignItems: "stretch"`
   wrapper in PlayTab — with `flex: 1` on the button itself to actually fill that stretched
   space).
   Two "trouble" states share one badge/popup treatment, also added 13 Aug at the user's
   request: recognizer errors (voiceError — mic blocked, Brave's broken backend, etc.) and
   heard-the-wake-word-but-didn't-match transcripts (voiceUnmatched). Rather than always-visible
   inline text (which competed for the same small footprint as the wind panel), the button
   greys out (CSS grayscale + reduced opacity) with a small yellow/black warning badge, and
   tapping it while either is set opens a popup with the actual message instead of toggling
   voice caddy on/off — worded and actioned differently per case (error: "Turn off voice
   caddy"/"Dismiss", since the badge reflects an ongoing problem that isn't going away on its
   own; unmatched: "Try again"/"Dismiss", since it's a one-off transient notice and both actions
   clear it — "Try again" additionally speaks a short reminder of the wake-word phrasing, since
   the golfer may not be looking at the screen). The two are mutually exclusive in practice —
   handleVoiceCommand clears whichever isn't relevant before setting the other — so `trouble`
   below is just whichever one is currently non-empty. The badge lives in an unfiltered sibling
   wrapper (not inside the grayscale'd button) so it stays full-color. */
function VoiceCaddyButton({ voiceOn, setVoiceOn, voiceMsg, voiceError, voiceUnmatched, setVoiceUnmatched, mePlayer, wakeWord }) {
  const supported = voiceSupported();
  const name = (wakeWord || "").trim() || "Gaddy";
  const [showTroublePopup, setShowTroublePopup] = useState(false);
  const trouble = voiceError || voiceUnmatched;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
      <div style={{ position: "relative", display: "flex", flexDirection: "column", flex: 1, width: "100%" }}>
        <button
          title={
            voiceError ? "Voice caddy trouble — tap for details"
            : voiceUnmatched ? "Didn't catch that — tap for details"
            : !supported ? "Voice control needs a browser with speech recognition (Chrome works best)"
            : !mePlayer ? "Mark a player as ⭐ you in the Players tab first"
            : voiceOn ? `Listening for "Hey ${name}, I'm using a..." or "Hey ${name}, record shot"`
            : "Turn on voice caddy"
          }
          disabled={!supported}
          onClick={() => { if (trouble) setShowTroublePopup(true); else setVoiceOn(!voiceOn); }}
          style={{
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
            flex: 1, minWidth: 58, border: `1px solid ${voiceOn ? C.flag : C.line}`, borderRadius: 8,
            background: voiceOn ? C.flag : C.white, padding: "0 10px", boxSizing: "border-box",
            opacity: supported ? 1 : 0.5, cursor: supported ? "pointer" : "not-allowed",
            filter: trouble ? "grayscale(1)" : "none",
          }}
        >
          <MicIcon size={18} color={voiceOn ? C.white : C.fairway} />
          <span style={{ fontFamily: sans, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: voiceOn ? C.white : C.turf, whiteSpace: "nowrap" }}>
            {name}
          </span>
        </button>
        {trouble && (
          <div
            aria-hidden="true"
            style={{
              position: "absolute", top: -6, right: -6, width: 17, height: 17, borderRadius: "50%",
              background: "#F2C230", color: "#1A1A14", border: "1.5px solid " + C.white,
              fontFamily: sans, fontSize: 11, fontWeight: 900, lineHeight: "1",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 1px 3px rgba(0,0,0,0.35)", pointerEvents: "none",
            }}
          >
            !
          </div>
        )}
      </div>
      {voiceOn && voiceMsg && !trouble && <div style={{ fontFamily: sans, fontSize: 11, color: C.turf, maxWidth: 150, textAlign: "center", marginTop: 3 }}>{voiceMsg}</div>}
      {showTroublePopup && trouble && (
        <div
          onClick={() => setShowTroublePopup(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(20,20,16,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 14 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.paper, borderRadius: 10, padding: 18, width: "100%", maxWidth: 340, boxSizing: "border-box" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div style={{ width: 22, height: 22, borderRadius: "50%", background: "#F2C230", color: "#1A1A14", fontFamily: sans, fontSize: 13, fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>!</div>
              <div style={{ fontFamily: serif, fontSize: 16, color: C.fairway }}>{voiceError ? "Voice caddy trouble" : "Didn't catch that"}</div>
            </div>
            <div style={{ fontFamily: sans, fontSize: 13, color: C.ink, lineHeight: 1.5, marginBottom: 16 }}>{trouble}</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              {voiceError ? (
                <>
                  <button style={btnGhost} onClick={() => { setVoiceOn(false); setShowTroublePopup(false); }}>Turn off voice caddy</button>
                  <button style={btnPrimary} onClick={() => setShowTroublePopup(false)}>Dismiss</button>
                </>
              ) : (
                <>
                  <button style={btnGhost} onClick={() => { setVoiceUnmatched(""); setShowTroublePopup(false); }}>Dismiss</button>
                  <button
                    style={btnPrimary}
                    onClick={() => {
                      speak(`Try again — say "Hey ${name}" plus a club name, or "Hey ${name}, record shot."`);
                      setVoiceUnmatched("");
                      setShowTroublePopup(false);
                    }}
                  >
                    Try again
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
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

/* dropdown shown from the ribbon's hamburger button while a round is being actively scored
   (compact header mode — see App()). Holds the same Play/Courses/Players/History navigation
   the full-width tab row normally shows, plus — separated by a divider, its own slot — a
   "Back to setup" action wired to the in-progress round's abandonRound(). A transparent
   full-viewport backdrop behind the panel closes it on an outside tap. */
function NavMenu({ tab, setTab, onClose, activeRound }) {
  const items = [
    { key: "play", label: "Play" },
    { key: "courses", label: "Courses" },
    { key: "players", label: "Players" },
    { key: "history", label: "History" },
  ];
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 40, background: "transparent" }} />
      <div
        style={{
          position: "absolute", top: "100%", left: 14, right: 14, zIndex: 50, marginTop: 6,
          background: C.white, border: `1px solid ${C.line}`, borderRadius: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,0.3)", overflow: "hidden",
        }}
      >
        {items.map((it) => (
          <button
            key={it.key}
            onClick={() => { setTab(it.key); onClose(); }}
            style={{
              display: "block", width: "100%", textAlign: "left", padding: "12px 16px",
              background: tab === it.key ? C.paper2 : "transparent", border: "none",
              borderBottom: `1px solid ${C.line}`, fontFamily: serif, fontSize: 14,
              textTransform: "uppercase", letterSpacing: "0.02em", cursor: "pointer",
              color: tab === it.key ? C.fairway : C.ink,
            }}
          >
            {it.label}
          </button>
        ))}
        {activeRound && (
          <button
            onClick={() => { activeRound.onBack(); onClose(); }}
            style={{
              display: "block", width: "100%", textAlign: "left", padding: "12px 16px",
              background: "transparent", border: "none", borderTop: `2px solid ${C.line}`,
              fontFamily: sans, fontSize: 13, fontWeight: 600, color: C.flag, cursor: "pointer",
            }}
          >
            ← Back to setup
          </button>
        )}
      </div>
    </>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      {/* fixed 2-line height regardless of actual label length — otherwise a short label like
          "Holes" sits on one line while a neighboring label like "Rating (optional)" wraps to
          two in a narrow grid column, and their inputs end up starting at different heights */}
      <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: C.turf, marginBottom: 5, fontFamily: sans, lineHeight: "14px", minHeight: 28, display: "flex", alignItems: "flex-end" }}>
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
  // No explicit height/line-height here on purpose — with native appearance stripped and the
  // same padding/border/font-size/box-sizing as inputStyle, the box model alone produces the
  // same height as a sibling text input. An earlier fixed height (44px) was a rounding guess
  // that ended up 2-3px taller than the real computed input height on the user's device.
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
/* the top green ribbon's menu toggle — only rendered while a round is actively being scored
   (see App()'s `compact` state), replacing the full Play/Courses/Players/History tab row to
   free up vertical space on the scoring screen. Sized/faded via inline transition so it visibly
   "grows in" as the tab row collapses, rather than just popping in. */
const hamburgerBtnStyle = {
  height: 34, borderRadius: 6, border: "1px solid rgba(251,249,242,0.35)",
  background: "rgba(251,249,242,0.12)", color: C.white, fontSize: 16, cursor: "pointer",
  display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, padding: 0,
};
const btnDanger = {
  background: "transparent", color: C.flag, border: `1px solid ${C.flag}`, borderRadius: 6,
  padding: "8px 12px", fontFamily: sans, fontSize: 13, fontWeight: 600, cursor: "pointer",
};
const thStyle = { textAlign: "left", padding: "9px 12px", borderBottom: `1px solid ${C.line}`, fontSize: 12, textTransform: "uppercase", color: C.turf };
const tdStyle = { padding: "9px 12px", borderBottom: `1px solid ${C.line}`, fontSize: 14 };
const cardStyle = { background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, padding: "16px 18px" };

/* compact table cell styles for the manual hole-entry grid specifically — that table has 5
   columns of mostly short values (numbers, a two-letter unit) packed into a narrow phone
   width, so it gets much tighter padding than the general-purpose thStyle/tdStyle above */
const holeThStyle = { textAlign: "center", padding: "6px 3px", borderBottom: `1px solid ${C.line}`, fontSize: 11, textTransform: "uppercase", color: C.turf };
const holeTdStyle = { padding: "5px 3px", borderBottom: `1px solid ${C.line}`, fontSize: 13, textAlign: "center" };
/* select with the browser's native appearance stripped so the chosen value is actually visible
   next to a small custom arrow, instead of the native control hiding the value behind its own
   arrow when squeezed into a narrow table cell (what was happening with the Par dropdown) */
const holeSelectStyle = {
  ...inputStyle, padding: "4px 16px 4px 2px", fontSize: 13, textAlign: "center", textAlignLast: "center",
  appearance: "none", WebkitAppearance: "none", MozAppearance: "none",
  backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 10 6'><path d='M0 0l5 6 5-6z' fill='%234b5d4a'/></svg>\")",
  backgroundRepeat: "no-repeat", backgroundPosition: "right 2px center",
};
const emptyStyle = { fontFamily: sans, fontSize: 15, color: C.turf, padding: "24px 0", textAlign: "center" };

/* ================= COURSES TAB ================= */
function CoursesTab({ courses, setCourses, location, requestLocation, distanceUnit }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [numHoles, setNumHoles] = useState(18);
  const [rating, setRating] = useState("");
  const [slope, setSlope] = useState("");
  /* tee-box colors (13 Aug feature, extended same day once OSM tee-box detection was added) —
     the holes table above always describes the "primary" tee (teeColor, defaulting to White);
     additional tee boxes are optional, entered manually (par/color/rating/slope/per-hole
     yardage, no GPS — see addExtraTee) OR auto-populated from OpenStreetMap's own colour-tagged
     `golf=tee` markers when a course has them (see applyOSMTeeSets below), in which case they
     DO carry real per-tee GPS via each extra tee's `teeLatLon` map (`fromOSM: true` marks
     these). A manually-added extra tee has no `teeLatLon`, so getTeeHole() falls back to the
     primary tee's shared location for it, same as before. */
  const [teeColor, setTeeColor] = useState("White");
  const [extraTees, setExtraTees] = useState([]);
  /* whether the CURRENT primary tee's yardage/GPS numbers came from a matched OSM tee set (see
     applyOSMHoles) — carried along so that if the primary is later swapped out via
     handleTeeColorChange, the demoted tee's "📍 OSM" badge (see extraTees.map render) stays
     accurate instead of always reading as manually-entered. */
  const [primaryFromOSM, setPrimaryFromOSM] = useState(false);
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

  function cacheOSMHoles(key, holes, teeSets) {
    const entry = { holes, teeSets: teeSets || [], cachedAt: Date.now() };
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
      // older cache entries (saved before the 13 Aug tee-box detection round) have no
      // `teeSets` field at all — applyOSMHoles treats that the same as "none found", so a
      // course cached before this feature simply won't show tee colors until a Refresh
      applyOSMHoles(cached.holes, cached.teeSets, cached.cachedAt);
      setOsmLoading(false);
      return;
    }
    try {
      const { holes: osmHoles, teeSets } = await fetchOSMHoles(candidate);
      cacheOSMHoles(key, osmHoles, teeSets); // cache successes AND genuine zero-result answers — never cache a failure
      applyOSMHoles(osmHoles, teeSets, null);
    } catch (e) {
      // fetchOSMHoles throws only when every Overpass mirror failed (timeout/rate-limit/network) —
      // that's a temporary service problem, not "this course has no holes", so say so and offer a retry
      setOsmFailed(true);
      setOsmStatus("Location set, but OpenStreetMap's hole-data service (Overpass) is currently rejecting requests — it's a known, widespread issue with the free public service, not specific to this device or how the app is hosted. Try the retry button below in a minute (it tries 3 different mirrors), or enter holes manually.");
    }
    setOsmLoading(false);
  }

  /* builds course.tees-shaped extra-tee entries (see saveCourse) from OSM-detected tee sets —
     everything EXCEPT whichever detected color matches the current primary teeColor (that one
     instead upgrades the primary holes table in-place, see applyOSMHoles below), so a course's
     "White"/primary tee never shows up twice. */
  function applyOSMTeeSets(teeSets, primaryColorKey) {
    const others = (teeSets || []).filter((s) => s.colorKey !== primaryColorKey);
    setExtraTees(others.map((s) => ({
      id: uid(), name: s.name, color: s.color, rating: "", slope: "",
      yardages: Object.fromEntries(Object.entries(s.holes).map(([num, h]) => [num, h.yardage ? String(h.yardage) : ""])),
      teeLatLon: Object.fromEntries(Object.entries(s.holes).map(([num, h]) => [num, { lat: h.teeLat, lon: h.teeLon }])),
      fromOSM: true,
    })));
  }

  function applyOSMHoles(osmHoles, teeSets, cachedAt) {
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

      // if OSM's own colour-tagged tee markers (see api/osm-holes.js / buildOSMTeeSets) include
      // a set matching the CURRENT primary tee color (teeColor, default "White"), use its real
      // per-tee GPS/yardage to upgrade the primary table's numbers in place — strictly more
      // accurate than the golf=hole-way-vertex fallback above, and it's the same tee either way
      // so this doesn't change what "the primary tee" means, just how precisely it's measured.
      const primaryKey = teeColor.trim().toLowerCase();
      const primarySet = (teeSets || []).find((s) => s.colorKey === primaryKey);
      if (primarySet) {
        newHoles.forEach((h) => {
          const override = primarySet.holes[h.number];
          if (override) {
            if (override.yardage != null) h.yardage = override.yardage;
            h.teeLat = override.teeLat;
            h.teeLon = override.teeLon;
          }
        });
      }
      setPrimaryFromOSM(!!primarySet);
      applyOSMTeeSets(teeSets, primaryKey);

      // most real-world OpenStreetMap golf mapping only draws tee-box shapes without ever
      // filling in the `tee=<colour>`/`ref=<hole>` tags this detection needs (confirmed by
      // checking several real, well-mapped courses live — bare `golf=tee` with no colour/ref
      // is the common case, not an edge case) — so finding 0 colors here is normal and expected
      // for most courses, not a sign anything is broken. Said explicitly so it doesn't read as
      // silent failure the way it did before this note existed.
      const teeNote = (teeSets || []).length
        ? ` — detected ${teeSets.length} tee color${teeSets.length !== 1 ? "s" : ""} on OpenStreetMap (${teeSets.map((s) => s.name).join(", ")})${
            primarySet ? "" : `; none matched the "${teeColor}" primary tee above, so the par/distance table still uses the course's general hole line — the detected colors are all listed as extra tees below`
          }; see the Tee boxes section below`
        : " — no colour-coded tee boxes found on OpenStreetMap for this course (most courses aren't mapped to that level of detail); if you know the different tee distances, add them below with \"+ Add another tee box\"";

      setNumHoles(total);
      setHoles(newHoles);
      setOsmStatus(`Found ${osmHoles.length} hole${osmHoles.length !== 1 ? "s" : ""} mapped on OpenStreetMap (${gpsCount} with tee/green GPS for live distance)${cacheNote}${teeNote} — review par/distance below before saving.`);
    } else {
      setExtraTees([]);
      setPrimaryFromOSM(false);
      setOsmStatus(`Location set from OpenStreetMap, but no hole-by-hole data is mapped for this course yet${cacheNote} — enter holes manually below.`);
    }
  }

  /* fires when the "par/distance table above is from the ___ tees" dropdown changes. Simply
     relabeling teeColor (the old behavior) left the table showing stale numbers from whatever
     tee was primary at OSM-fetch time — reported by the user as "the yardages don't change when
     I select a tee box color, so I have no way of knowing if it finds the different color tee
     boxes." Fix: if the newly-picked color already has data sitting in extraTees (whether
     OSM-detected or manually entered), swap it into the primary table/rating/slope right now,
     and demote the outgoing primary's data into its place in extraTees — so no data is ever
     lost, and the table always reflects whichever tee is currently selected as primary. If the
     newly-picked color has no known data yet, this is just the plain manual-entry case (e.g.
     switching the label before ever filling anything in) — behaves exactly as before: relabel
     only, nothing to swap. */
  function handleTeeColorChange(newColor) {
    if (newColor === teeColor) return;
    const match = extraTees.find((t) => t.name === newColor);
    if (!match) { setTeeColor(newColor); return; }
    const oldPreset = TEE_PRESETS.find((p) => p.name === teeColor);
    const demoted = {
      id: uid(),
      name: teeColor,
      color: oldPreset?.color || C.turf,
      rating, slope,
      yardages: Object.fromEntries(holes.map((h) => [h.number, h.yardage !== "" && h.yardage != null ? String(h.yardage) : ""])),
      teeLatLon: Object.fromEntries(holes.map((h) => [h.number, { lat: h.teeLat, lon: h.teeLon }])),
      fromOSM: primaryFromOSM,
    };
    setHoles(holes.map((h) => {
      const y = match.yardages[h.number];
      const gps = match.teeLatLon?.[h.number];
      return {
        ...h,
        yardage: y !== undefined && y !== "" ? Number(y) : h.yardage,
        teeLat: gps ? gps.lat : h.teeLat,
        teeLon: gps ? gps.lon : h.teeLon,
      };
    }));
    setRating(match.rating || "");
    setSlope(match.slope || "");
    setPrimaryFromOSM(!!match.fromOSM);
    setExtraTees([...extraTees.filter((t) => t.id !== match.id), demoted]);
    setTeeColor(newColor);
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
      const { holes: osmHoles, teeSets } = await fetchOSMHoles(lastOSMCandidate);
      cacheOSMHoles(osmCacheKey(lastOSMCandidate), osmHoles, teeSets);
      applyOSMHoles(osmHoles, teeSets, null);
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
    setTeeColor("White"); setExtraTees([]); setPrimaryFromOSM(false);
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
  function nextUnusedPreset() {
    const used = new Set([teeColor, ...extraTees.map((t) => t.name)]);
    return TEE_PRESETS.find((p) => !used.has(p.name)) || TEE_PRESETS[0];
  }
  function addExtraTee() {
    const preset = nextUnusedPreset();
    setExtraTees([...extraTees, { id: uid(), name: preset.name, color: preset.color, rating: "", slope: "", yardages: {} }]);
  }
  function updateExtraTee(i, field, val) {
    const next = [...extraTees];
    if (field === "name") {
      const preset = TEE_PRESETS.find((p) => p.name === val);
      next[i] = { ...next[i], name: val, color: preset?.color || next[i].color };
    } else {
      next[i] = { ...next[i], [field]: val };
    }
    setExtraTees(next);
  }
  function updateExtraTeeYardage(i, holeNumber, val) {
    const next = [...extraTees];
    next[i] = { ...next[i], yardages: { ...next[i].yardages, [holeNumber]: val } };
    setExtraTees(next);
  }
  function removeExtraTee(i) {
    setExtraTees(extraTees.filter((_, idx) => idx !== i));
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
    const primaryPreset = TEE_PRESETS.find((p) => p.name === teeColor);
    const primaryTeeHoles = {};
    holes.forEach((h) => {
      primaryTeeHoles[h.number] = { yardage: h.yardage ? Number(h.yardage) : null, teeLat: h.teeLat ?? null, teeLon: h.teeLon ?? null };
    });
    const tees = [
      {
        id: uid(), name: teeColor, color: primaryPreset?.color || C.turf,
        rating: rating ? Number(rating) : null, slope: slope ? Number(slope) : null,
        holes: primaryTeeHoles,
      },
      ...extraTees.map((t) => {
        const teeHoles = {};
        holes.forEach((h) => {
          const yd = t.yardages[h.number];
          // manually-added extra tees (no `teeLatLon` — see addExtraTee) don't collect their
          // own GPS pin, so teeLat/teeLon stays unset and getTeeHole() falls back to the
          // primary tee's location for them; OSM-detected extra tees (fromOSM: true, populated
          // by applyOSMTeeSets) carry a real per-hole GPS point in `teeLatLon`, used here as-is
          const gps = t.teeLatLon?.[h.number];
          teeHoles[h.number] = { yardage: yd ? Number(yd) : null, teeLat: gps?.lat ?? null, teeLon: gps?.lon ?? null };
        });
        return {
          id: t.id, name: t.name, color: t.color,
          rating: t.rating ? Number(t.rating) : null, slope: t.slope ? Number(t.slope) : null,
          holes: teeHoles,
        };
      }),
    ];
    const course = {
      id: uid(), name: name.trim(),
      lat: manualLat !== "" ? Number(manualLat) : null,
      lon: manualLon !== "" ? Number(manualLon) : null,
      rating: rating ? Number(rating) : null, slope: slope ? Number(slope) : null,
      holes: holes.map((h) => ({
        number: h.number, par: Number(h.par) || 4, yardage: h.yardage ? Number(h.yardage) : null, strokeIndex: h.strokeIndex ? Number(h.strokeIndex) : null,
        teeLat: h.teeLat ?? null, teeLon: h.teeLon ?? null, greenLat: h.greenLat ?? null, greenLon: h.greenLon ?? null,
      })),
      tees,
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
            <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", fontFamily: mono, fontSize: 13 }}>
              <colgroup>
                <col style={{ width: "12%" }} /><col style={{ width: "16%" }} /><col style={{ width: "30%" }} /><col style={{ width: "24%" }} /><col style={{ width: "18%" }} />
              </colgroup>
              <thead>
                <tr style={{ background: C.paper, position: "sticky", top: 0 }}>
                  <th style={holeThStyle}>Hole</th><th style={holeThStyle}>Par</th><th style={holeThStyle}>Dist ({distanceUnit === "m" ? "m" : "yd"})</th><th style={holeThStyle}>Str. Idx</th><th style={holeThStyle}>GPS</th>
                </tr>
              </thead>
              <tbody>
                {holes.map((h, i) => (
                  <tr key={i}>
                    <td style={holeTdStyle}>{h.number}</td>
                    <td style={holeTdStyle}>
                      <select style={holeSelectStyle} value={h.par} onChange={(e) => updateHole(i, "par", e.target.value)}>
                        {[3, 4, 5].map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </td>
                    <td style={holeTdStyle}>
                      <input style={{ ...inputStyle, padding: "4px 3px", fontSize: 13, textAlign: "center" }}
                        value={displayDistance(h.yardage, distanceUnit)}
                        onChange={(e) => updateHole(i, "yardage", toYardsFromInput(e.target.value, distanceUnit))}
                        placeholder={distanceUnit === "m" ? "m" : "yds"} />
                    </td>
                    <td style={holeTdStyle}>
                      <select style={holeSelectStyle} value={h.strokeIndex} onChange={(e) => updateHole(i, "strokeIndex", e.target.value)}>
                        <option value="">–</option>
                        {Array.from({ length: 18 }, (_, k) => k + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </td>
                    <td style={holeTdStyle} title={h.greenLat != null ? "Tee/green GPS from OpenStreetMap — live distance & drive tracking available" : "No GPS data for this hole"}>
                      {h.greenLat != null ? "📍" : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 16 }}>
            <div style={{ fontFamily: sans, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: C.turf, marginBottom: 8 }}>Tee boxes</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", display: "inline-block", background: TEE_PRESETS.find((p) => p.name === teeColor)?.color, border: `1px solid ${C.line}`, flexShrink: 0 }} />
              <span style={{ fontFamily: sans, fontSize: 12, color: C.turf }}>The par/distance table above is from the</span>
              <select style={selectStyle} value={teeColor} onChange={(e) => handleTeeColorChange(e.target.value)}>
                {TEE_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
              <span style={{ fontFamily: sans, fontSize: 12, color: C.turf }}>tees</span>
            </div>

            {extraTees.map((t, i) => (
              <div key={t.id} style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 6, padding: 10, marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", display: "inline-block", background: t.color, border: `1px solid ${C.line}`, flexShrink: 0 }} />
                  <select style={selectStyle} value={t.name} onChange={(e) => updateExtraTee(i, "name", e.target.value)}>
                    {TEE_PRESETS.some((p) => p.name === t.name) ? null : <option value={t.name}>{t.name}</option>}
                    {TEE_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                  {t.fromOSM && (
                    <span title="Detected from a colour-tagged tee marker on OpenStreetMap — includes real GPS for this tee"
                      style={{ fontFamily: sans, fontSize: 10, color: C.fairway, border: `1px solid ${C.fairway}`, borderRadius: 4, padding: "2px 5px" }}>
                      📍 OSM
                    </span>
                  )}
                  <input style={{ ...inputStyle, width: 80 }} placeholder="Rating" value={t.rating} onChange={(e) => updateExtraTee(i, "rating", e.target.value)} />
                  <input style={{ ...inputStyle, width: 70 }} placeholder="Slope" value={t.slope} onChange={(e) => updateExtraTee(i, "slope", e.target.value)} />
                  <button style={{ ...btnDanger, marginLeft: "auto" }} onClick={() => removeExtraTee(i)}>Remove</button>
                </div>
                <div style={{ fontFamily: sans, fontSize: 11, color: C.turf, marginBottom: 6 }}>
                  Distance per hole ({distanceUnit === "m" ? "m" : "yd"}) — par and stroke index come from the table above
                  {t.fromOSM ? "; yardages pre-filled from OpenStreetMap, editable if needed" : ""}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(58px, 1fr))", gap: 6 }}>
                  {holes.map((h) => (
                    <div key={h.number} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                      <span style={{ fontFamily: mono, fontSize: 10, color: C.turf }}>#{h.number}</span>
                      <input
                        style={{ ...inputStyle, width: "100%", padding: "3px 4px", fontSize: 12, textAlign: "center", boxSizing: "border-box" }}
                        value={displayDistance(t.yardages[h.number] || "", distanceUnit)}
                        onChange={(e) => updateExtraTeeYardage(i, h.number, toYardsFromInput(e.target.value, distanceUnit))}
                        placeholder={distanceUnit === "m" ? "m" : "yds"}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <button style={{ ...btnGhost, fontSize: 12 }} onClick={addExtraTee} disabled={extraTees.length >= TEE_PRESETS.length - 1}>+ Add another tee box</button>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
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
            {c.tees?.length > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                {c.tees.map((t) => (
                  <span key={t.id} style={{ display: "flex", alignItems: "center", gap: 3, fontFamily: sans, fontSize: 11, color: C.turf }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", display: "inline-block", background: t.color, border: `1px solid ${C.line}` }} />
                    {t.name}
                  </span>
                ))}
              </div>
            )}
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
    // minmax(0, 1fr) (not plain 1fr) lets each column shrink below its content's natural
    // width instead of forcing the grid wider than its container — combined with the
    // abbreviated labels below and minWidth:0 on the row/input, this is what actually keeps
    // the whole editor inside the card instead of needing horizontal scroll.
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "4px 10px", width: "100%", boxSizing: "border-box" }}>
      {CLUBS.map((club) => {
        const has = bagHasClub(bag, club);
        const yards = bagDistance(bag, club);
        return (
          <div key={club} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0", minWidth: 0 }}>
            <label title={club} style={{ display: "flex", alignItems: "center", gap: 5, fontFamily: sans, fontSize: 13, color: C.ink, cursor: "pointer", flexShrink: 0 }}>
              <input type="checkbox" checked={has} onChange={() => onChange(toggleBagClub(bag, club))} />
              {CLUB_ABBREV[club] || club}
            </label>
            {has && (
              <input
                type="number"
                style={{ ...inputStyle, width: 56, minWidth: 0, padding: "5px 6px" }}
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

function BetterBallHoleCard({ hole, teamKey, teamColor, teamLabel, playerAName, playerBName, playerAId, playerBId, state, onUpdate, onMarkDrive, onMarkShot, livePos, distanceUnit, mePlayerId, meBag, course, teeAssign }) {
  const s = state || defaultBBHole();
  const remainingYards = hole.greenLat != null && livePos ? haversineYards(livePos.lat, livePos.lon, hole.greenLat, hole.greenLon) : null;
  const suggestion = meBag?.length > 0 ? suggestClub(meBag, remainingYards) : null;
  const unitLabel = distanceUnit === "m" ? "m" : "y";
  const courseTees = course ? getCourseTees(course) : [];
  const defaultTeeId = courseTees[0]?.id;
  function teeInfoFor(pid) {
    const teeId = teeAssign?.[pid] || defaultTeeId;
    const tee = courseTees.find((t) => t.id === teeId);
    if (!tee || teeId === defaultTeeId) return null;
    const teeHole = course ? getTeeHole(course, teeId, hole.number) : null;
    return { tee, yardage: teeHole?.yardage };
  }
  const teeInfoA = teeInfoFor(playerAId);
  const teeInfoB = teeInfoFor(playerBId);

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
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px", background: C.white, flex: 1, minWidth: 260, maxWidth: "100%", boxSizing: "border-box" }}>
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
                      {teeInfoA && (
                        <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 1, marginBottom: 2 }}>
                          <span style={{ width: 7, height: 7, borderRadius: "50%", display: "inline-block", background: teeInfoA.tee.color, border: `1px solid ${C.line}`, flexShrink: 0 }} />
                          <span style={{ fontFamily: sans, fontSize: 10, color: C.turf }}>
                            {teeInfoA.tee.name}{teeInfoA.yardage ? ` · ${displayDistance(teeInfoA.yardage, distanceUnit)}${unitLabel}` : ""}
                          </span>
                        </div>
                      )}
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
                      {teeInfoB && (
                        <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 1, marginBottom: 2 }}>
                          <span style={{ width: 7, height: 7, borderRadius: "50%", display: "inline-block", background: teeInfoB.tee.color, border: `1px solid ${C.line}`, flexShrink: 0 }} />
                          <span style={{ fontFamily: sans, fontSize: 10, color: C.turf }}>
                            {teeInfoB.tee.name}{teeInfoB.yardage ? ` · ${displayDistance(teeInfoB.yardage, distanceUnit)}${unitLabel}` : ""}
                          </span>
                        </div>
                      )}
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

/* single "focused" hole in the per-hole better-ball scoring view — same hole-number/par/stroke
   index/distance header as the stroke-play version, wrapping the existing per-team
   BetterBallHoleCard(s) side by side underneath, plus the same Next/Finish hole button. */
function BetterBallFocusedHole({
  hole, isLast, solo, pA1, pB1, pA2, pB2, team1Ids, team2Ids, bbState, distanceUnit, livePos,
  mePlayerId, mePlayer, course, teeAssign, onUpdateTeam1, onUpdateTeam2, onMarkDrive1, onMarkShot1, onMarkDrive2, onMarkShot2, onNext,
}) {
  const liveYards = hole.greenLat != null && livePos ? haversineYards(livePos.lat, livePos.lon, hole.greenLat, hole.greenLon) : null;
  const unitLabel = distanceUnit === "m" ? "m" : "y";
  return (
    <div style={{ padding: 12, background: C.white }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10, gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
          <div style={{ fontFamily: serif, fontSize: 36, color: C.fairway, lineHeight: 1 }}>{hole.number}</div>
          <div style={{ fontFamily: sans, fontSize: 12, color: C.turf, lineHeight: 1.5 }}>
            <div>Par <b style={{ color: C.ink, fontSize: 14 }}>{hole.par}</b></div>
            {hole.strokeIndex ? <div>SI <b style={{ color: C.ink, fontSize: 14 }}>{hole.strokeIndex}</b></div> : null}
          </div>
        </div>
        <div style={{ textAlign: "right", fontFamily: sans, fontSize: 12, color: C.turf, flexShrink: 0 }}>
          {hole.yardage ? <div>{displayDistance(hole.yardage, distanceUnit)}{unitLabel}</div> : null}
          {liveYards != null && (
            <div style={{ color: C.fairway, fontWeight: 700 }}>📍 {Math.round(displayDistance(liveYards, distanceUnit))}{unitLabel}</div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <BetterBallHoleCard hole={hole} teamKey="team1" teamColor={C.team1} teamLabel={solo ? "Better Ball" : "Team 1"} playerAName={pA1?.name || "A"} playerBName={pB1?.name || "B"}
          playerAId={team1Ids[0]} playerBId={team1Ids[1]}
          state={bbState.team1?.[hole.number]} onUpdate={onUpdateTeam1}
          onMarkDrive={onMarkDrive1} onMarkShot={onMarkShot1}
          livePos={livePos} distanceUnit={distanceUnit} mePlayerId={mePlayerId} meBag={mePlayer?.bag}
          course={course} teeAssign={teeAssign} />
        {!solo && (
          <BetterBallHoleCard hole={hole} teamKey="team2" teamColor={C.team2} teamLabel="Team 2" playerAName={pA2?.name || "A"} playerBName={pB2?.name || "B"}
            playerAId={team2Ids[0]} playerBId={team2Ids[1]}
            state={bbState.team2?.[hole.number]} onUpdate={onUpdateTeam2}
            onMarkDrive={onMarkDrive2} onMarkShot={onMarkShot2}
            livePos={livePos} distanceUnit={distanceUnit} mePlayerId={mePlayerId} meBag={mePlayer?.bag}
            course={course} teeAssign={teeAssign} />
        )}
      </div>

      <button style={{ ...btnPrimary, width: "100%", marginTop: 12, boxSizing: "border-box" }} onClick={onNext}>
        {isLast ? "Finish hole →" : "Next hole →"}
      </button>
    </div>
  );
}

/* single "focused" hole in the per-hole stroke-play scoring view — occupies most of the
   screen while active; one compact card per selected player inside it. Direction/putts and
   shot-marking sit side by side as equal-width flex columns so neither overflows the card. */
function StrokeHoleCard({ hole, isLast, players, selected, scores, distanceUnit, livePos, mePlayer, course, teeAssign, onScoreField, onMarkDrive, onMarkNextShot, onNext }) {
  const liveYards = hole.greenLat != null && livePos ? haversineYards(livePos.lat, livePos.lon, hole.greenLat, hole.greenLon) : null;
  const suggestion = liveYards != null && mePlayer?.bag?.length ? suggestClub(mePlayer.bag, liveYards) : null;
  const unitLabel = distanceUnit === "m" ? "m" : "y";
  /* the header distance above reflects the course's first/default tee; when a player is
     assigned a different tee box (13 Aug tee-color feature) their own tee's yardage — which can
     differ meaningfully — is shown under their name instead of repeating the shared header */
  const courseTees = course ? getCourseTees(course) : [];
  const defaultTeeId = courseTees[0]?.id;

  return (
    <div style={{ padding: 12, background: C.white }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10, gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
          <div style={{ fontFamily: serif, fontSize: 36, color: C.fairway, lineHeight: 1 }}>{hole.number}</div>
          <div style={{ fontFamily: sans, fontSize: 12, color: C.turf, lineHeight: 1.5 }}>
            <div>Par <b style={{ color: C.ink, fontSize: 14 }}>{hole.par}</b></div>
            {hole.strokeIndex ? <div>SI <b style={{ color: C.ink, fontSize: 14 }}>{hole.strokeIndex}</b></div> : null}
          </div>
        </div>
        <div style={{ textAlign: "right", fontFamily: sans, fontSize: 12, color: C.turf, flexShrink: 0 }}>
          {hole.yardage ? <div>{displayDistance(hole.yardage, distanceUnit)}{unitLabel}</div> : null}
          {liveYards != null && (
            <div style={{ color: C.fairway, fontWeight: 700 }}>📍 {Math.round(displayDistance(liveYards, distanceUnit))}{unitLabel}</div>
          )}
          {suggestion && <div style={{ color: C.fairway }}>🎒 {CLUB_ABBREV[suggestion] || suggestion}</div>}
        </div>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {selected.map((pid) => {
          const cell = scores[pid]?.[hole.number] || {};
          const player = players.find((p) => p.id === pid);
          const extraShots = cell.extraShots || [];
          const playerTeeId = teeAssign?.[pid] || defaultTeeId;
          const playerTee = courseTees.find((t) => t.id === playerTeeId);
          const playerTeeHole = course ? getTeeHole(course, playerTeeId, hole.number) : null;
          const showPlayerTee = playerTee && playerTeeId !== defaultTeeId;
          return (
            <div key={pid} style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: 8 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, gap: 8 }}>
                <div style={{ minWidth: 0, overflow: "hidden" }}>
                  <div style={{ fontFamily: sans, fontSize: 13, fontWeight: 700, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{player?.name}</div>
                  {showPlayerTee && (
                    <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", display: "inline-block", background: playerTee.color, border: `1px solid ${C.line}`, flexShrink: 0 }} />
                      <span style={{ fontFamily: sans, fontSize: 10, color: C.turf }}>
                        {playerTee.name}{playerTeeHole?.yardage ? ` · ${displayDistance(playerTeeHole.yardage, distanceUnit)}${unitLabel}` : ""}
                      </span>
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <input
                    type="number"
                    style={{ width: 44, padding: "5px 6px", fontFamily: mono, fontSize: 16, border: `1px solid ${C.line}`, borderRadius: 5, boxSizing: "border-box" }}
                    value={cell.gross ?? ""}
                    onChange={(e) => onScoreField(pid, hole.number, "gross", e.target.value)}
                  />
                  <ScoreBadge gross={cell.gross} par={hole.par} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.03em", color: C.turf, fontFamily: sans, marginBottom: 3 }}>Direction</div>
                  <ShapeSelector par={hole.par} value={cell.shape} onChange={(v) => onScoreField(pid, hole.number, "shape", v)} />
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                    <span style={{ fontSize: 11, color: C.turf, fontFamily: sans }}>Putts</span>
                    <input
                      type="number"
                      style={{ width: 38, padding: "4px 5px", fontFamily: mono, fontSize: 13, border: `1px solid ${C.line}`, borderRadius: 4, boxSizing: "border-box" }}
                      value={cell.putts ?? ""}
                      onChange={(e) => onScoreField(pid, hole.number, "putts", e.target.value)}
                    />
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.03em", color: C.turf, fontFamily: sans, marginBottom: 3 }}>Shots</div>
                  {hole.teeLat != null && (
                    <button style={{ ...btnGhost, fontSize: 10, padding: "4px 6px", width: "100%", boxSizing: "border-box" }} onClick={() => onMarkDrive(pid)}>
                      {cell.driveYards ? `📍 ${Math.round(displayDistance(cell.driveYards, distanceUnit))}${unitLabel}` : "📍 Mark drive"}
                    </button>
                  )}
                  <select
                    style={{ ...inputStyle, width: "100%", boxSizing: "border-box", padding: "3px 4px", fontSize: 11, marginTop: 4 }}
                    value={cell.club || ""}
                    onChange={(e) => onScoreField(pid, hole.number, "club", e.target.value || null)}
                  >
                    <option value="">Club —</option>
                    {CLUBS.map((c) => <option key={c} value={c}>{CLUB_ABBREV[c] || c}</option>)}
                  </select>
                  {hole.teeLat != null && extraShots.map((es, i) => (
                    <div key={i} style={{ fontSize: 10, color: C.turf, fontFamily: sans, marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ flexShrink: 0 }}>S{i + 2}: {es.yards != null ? `${Math.round(displayDistance(es.yards, distanceUnit))}${unitLabel}` : "—"}</span>
                      <select
                        style={{ ...inputStyle, flex: 1, minWidth: 0, padding: "2px 3px", fontSize: 10 }}
                        value={es.club || ""}
                        onChange={(e) => {
                          const next = [...extraShots];
                          next[i] = { ...next[i], club: e.target.value || null };
                          onScoreField(pid, hole.number, "extraShots", next);
                        }}
                      >
                        <option value="">—</option>
                        {CLUBS.map((c) => <option key={c} value={c}>{CLUB_ABBREV[c] || c}</option>)}
                      </select>
                    </div>
                  ))}
                  {hole.teeLat != null && (
                    <button style={{ ...btnGhost, fontSize: 10, padding: "4px 6px", marginTop: 4, width: "100%", boxSizing: "border-box" }} onClick={() => onMarkNextShot(pid)}>
                      + Next shot
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <button style={{ ...btnPrimary, width: "100%", marginTop: 12, boxSizing: "border-box" }} onClick={onNext}>
        {isLast ? "Finish hole →" : "Next hole →"}
      </button>
    </div>
  );
}

/* ================= PLAY TAB ================= */
function PlayTab({ courses, players, setPlayers, rounds, setRounds, distanceUnit, mePlayerId, voiceWakeWord, onActiveRoundChange }) {
  /* resume an in-progress round after an accidental tab/app close — read once at mount */
  const [savedRound] = useState(() => loadKey(ACTIVE_ROUND_KEY, null));
  const [step, setStep] = useState(savedRound ? "scoring" : "setup");
  const [format, setFormat] = useState(savedRound?.format || "stroke");
  const [courseId, setCourseId] = useState(savedRound?.courseId || courses[0]?.id || "");
  const [selected, setSelected] = useState(savedRound?.selected || []);
  const [overrides, setOverrides] = useState(savedRound?.overrides || {});
  const [scores, setScores] = useState(savedRound?.scores || {});
  const [teamAssign, setTeamAssign] = useState(savedRound?.teamAssign || {});
  /* which tee-color set (from course.tees) each selected player is playing from — 13 Aug tee-box
     feature. Keyed by player id, value is a tee id (see getCourseTees/getTeeHole). Defaulted to
     the course's first tee as each player is selected (see togglePlayer); reset whenever the
     course itself changes, since tee ids are course-specific and stale ids would silently fall
     back to tees[0] anyway via teeIdFor() — resetting avoids carrying a same-shaped-but-wrong id
     across courses. */
  const [teeAssign, setTeeAssign] = useState(savedRound?.teeAssign || {});
  const [bbState, setBbState] = useState(savedRound?.bbState || { team1: {}, team2: {} });
  const [startHole, setStartHole] = useState(savedRound?.startHole || 1);
  const [activeIdx, setActiveIdx] = useState(savedRound?.activeIdx ?? 0);
  const [driveModal, setDriveModal] = useState(null);
  const [voiceOn, setVoiceOn] = useState(false);
  const [voiceMsg, setVoiceMsg] = useState("");
  /* recognizer-level errors (mic blocked, Brave's broken backend, etc.) are tracked separately
     from voiceMsg — per the user's 13 Aug request, these no longer show as inline text under
     the button; instead the button greys out with a warning badge and this text surfaces in a
     tap-to-open popup (see VoiceCaddyButton) instead of always-visible text competing for the
     same small footprint as the wind panel next to it. */
  const [voiceError, setVoiceError] = useState("");
  /* same treatment, 13 Aug, for "heard the wake word but didn't recognize what followed" —
     also moved out of the always-visible voiceMsg line into the badge+popup pattern, with
     "Try again"/"Dismiss" actions instead of error's "Turn off"/"Dismiss" (see VoiceCaddyButton).
     Mutually exclusive with voiceError in practice — handleVoiceCommand clears whichever one
     isn't relevant to the current event before setting the other. */
  const [voiceUnmatched, setVoiceUnmatched] = useState("");
  const [resumedNotice, setResumedNotice] = useState(!!savedRound);

  /* clear stale trouble state as soon as voice caddy is turned off (manually, or via a popup's
     "Turn off"/dismiss action) — next time it's turned on it starts clean rather than showing a
     greyed-out/badged button before anything has actually happened this session. */
  useEffect(() => { if (!voiceOn) { setVoiceError(""); setVoiceUnmatched(""); } }, [voiceOn]);

  const course = courses.find((c) => c.id === courseId);
  const livePos = useLivePosition(step === "scoring");
  const mePlayer = players.find((p) => p.id === mePlayerId);

  /* resolve a player's assigned tee id, falling back to the course's first tee if unset (e.g.
     a player selected before teeAssign existed, or a stale id from a since-changed course) */
  function teeIdFor(pid) { return teeAssign[pid] || getCourseTees(course)[0]?.id; }

  /* tee ids are course-specific — if the chosen course changes mid-setup, drop any assignments
     so nobody's silently left pointing at another course's tee id. Guarded against firing on
     mount (which would wipe a resumed round's teeAssign before it's ever read). */
  const prevCourseIdRef = useRef(courseId);
  useEffect(() => {
    if (prevCourseIdRef.current !== courseId) {
      setTeeAssign({});
      prevCourseIdRef.current = courseId;
    }
  }, [courseId]);

  /* wind indicator: prefer the course's own stored coordinates (stable — doesn't refetch as
     the golfer walks the course); if the course has none, lock onto the first GPS fix of the
     round instead of re-resolving on every position update (wind doesn't need to track you
     hole to hole, and refetching on every GPS tick would hammer the API for no benefit). */
  const firstLivePosRef = useRef(null);
  useEffect(() => { if (!firstLivePosRef.current && livePos) firstLivePosRef.current = livePos; }, [livePos]);
  const windPos = course?.lat != null && course?.lon != null ? { lat: course.lat, lon: course.lon } : firstLivePosRef.current;
  const wind = useWindData(windPos?.lat, windPos?.lon, distanceUnit === "m" ? "kmh" : "mph");
  const compass = useCompassHeading(step === "scoring");

  /* per-hole scoring view (both formats): holes reordered to start from the chosen tee, one
     hole "active" (fully visible) at a time; holes before activeIdx have been stepped past and
     render collapsed */
  const playOrder = useMemo(() => (course ? playOrderHoles(course.holes, startHole) : []), [course, startHole]);
  const roundComplete = activeIdx >= playOrder.length;
  const activeHole = !roundComplete ? playOrder[activeIdx] : null;

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
    saveKey(ACTIVE_ROUND_KEY, { format, courseId, selected, overrides, scores, teamAssign, teeAssign, bbState, startHole, activeIdx });
  }, [step, format, courseId, selected, overrides, scores, teamAssign, teeAssign, bbState, startHole, activeIdx]);

  /* tells App() whether a round is actively being scored right now, plus enough to render the
     ribbon's compact header (course name / format) and let its hamburger menu's "Back to
     setup" item reach this round's abandonRound() — see the ribbon-collapse feature in App(). */
  useEffect(() => {
    if (step === "scoring" && course) {
      onActiveRoundChange({
        courseName: course.name,
        formatLabel: format === "betterball" ? "Better Ball" : "Stroke Play",
        onBack: abandonRound,
      });
    } else {
      onActiveRoundChange(null);
    }
    return () => onActiveRoundChange(null);
  }, [step, course, format]);

  function togglePlayer(id) {
    if (selected.includes(id)) {
      setSelected(selected.filter((s) => s !== id));
      const next = { ...teamAssign }; delete next[id]; setTeamAssign(next);
      const nextTee = { ...teeAssign }; delete nextTee[id]; setTeeAssign(nextTee);
    } else if (selected.length < 4) {
      setSelected([...selected, id]);
      setTeeAssign({ ...teeAssign, [id]: getCourseTees(course)[0]?.id });
    }
  }
  function setTeam(pid, team) { setTeamAssign({ ...teamAssign, [pid]: team }); }
  function setPlayerTee(pid, teeId) { setTeeAssign({ ...teeAssign, [pid]: teeId }); }

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
    setActiveIdx(0);
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
  const activeHoleRef = useRef(activeHole);
  const teeAssignRef = useRef(teeAssign);
  useEffect(() => { mePlayerIdRef.current = mePlayerId; }, [mePlayerId]);
  useEffect(() => { livePosRef.current = livePos; }, [livePos]);
  useEffect(() => { courseRef.current = course; }, [course]);
  useEffect(() => { formatRef.current = format; }, [format]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { activeHoleRef.current = activeHole; });
  useEffect(() => { scoresRef.current = scores; }, [scores]);
  useEffect(() => { bbStateRef.current = bbState; }, [bbState]);
  useEffect(() => { team1IdsRef.current = team1Ids; });
  useEffect(() => { team2IdsRef.current = team2Ids; });
  useEffect(() => { teeAssignRef.current = teeAssign; }, [teeAssign]);

  const handleVoiceCommand = useCallback((kind, payload, transcript) => {
    if (kind === "error") {
      // no spoken reply — if speech recognition itself is broken, speaking to the user via the
      // same broken pipeline's assumptions isn't reliable, and a silent visible message is safer.
      // Surfaced via voiceError (greyed-out button + warning badge + tap-to-open popup — see
      // VoiceCaddyButton), not the inline voiceMsg line other commands use below.
      const known = { network: "couldn't reach the speech recognition service", "not-allowed": "microphone access was blocked", "service-not-allowed": "speech recognition isn't allowed here", "audio-capture": "no microphone was found" };
      const why = known[payload] || `error: ${payload}`;
      setVoiceError(`Voice caddy stopped hearing anything (${why}). Some browsers — Brave is the known one — start the mic but don't actually run speech recognition. Try Chrome if this keeps happening.`);
      return;
    }
    // reaching here means the recognizer just produced a real transcript, proof it's actually
    // working again — clear any stale error state from an earlier failed attempt. (Unconditional
    // rather than reading voiceError first: this callback is memoized with an empty deps array,
    // so a closed-over voiceError value would always be stale; setVoiceError("") when it's
    // already "" is a harmless no-op re-render.)
    setVoiceError("");
    // only "unmatched" itself re-sets voiceUnmatched below — clear it here for every other kind
    // so a stale "didn't catch that" badge doesn't linger once a command actually succeeds
    if (kind !== "unmatched") setVoiceUnmatched("");
    const me = mePlayerIdRef.current;
    if (!me) { setVoiceMsg("Mark a player as ⭐ you in the Players tab first."); speak("Mark a player as you first."); return; }
    // both formats now use the same per-hole view — voice/auto-detect always target whichever
    // hole is currently active there, not whatever GPS thinks is nearest
    const hole = activeHoleRef.current;
    if (!hole) {
      setVoiceMsg("No active hole right now — the round looks finished.");
      speak("No active hole to record for.");
      return;
    }

    if (kind === "unmatched") {
      // deliberately no spoken reply on its own here — a wake word alone shouldn't interrupt
      // mid-swing; the badge + popup (see VoiceCaddyButton) is what lets a mis-heard phrase be
      // diagnosed instead of looking like the mic just isn't picking anything up at all. Voice
      // caddy itself only speaks in response to the popup's own "Try again" tap (a deliberate
      // user action), not automatically on every unmatched utterance.
      setVoiceUnmatched(`Heard: "${transcript}" — didn't catch a club name or "record shot". Try "I'm using a 6 iron" or "record shot".`);
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
      // "you" (the voice caddy only ever tracks mePlayerId) might be on a different tee box
      // than the shared hole object's default tee — same call-site override as the manual
      // mark-drive buttons (see markDriveForStroke's comment)
      const myTee = getTeeHole(courseRef.current, (teeAssignRef.current || {})[me] || getCourseTees(courseRef.current)[0]?.id, hole.number);
      const holeForMe = { ...hole, teeLat: myTee.teeLat, teeLon: myTee.teeLon };
      const pending = computePendingShot({
        hole: holeForMe, format: formatRef.current, mePlayerId: me, selected: selectedRef.current,
        scores: scoresRef.current, bbState: bbStateRef.current,
        team1Ids: team1IdsRef.current, team2Ids: team2IdsRef.current,
      });
      if (!pending) { setVoiceMsg('Heard "record shot" but there\'s nothing pending to mark for you right now.'); speak("Nothing to record right now."); return; }
      const posArg = { lat: pos.lat, lon: pos.lon };
      let result;
      if (pending.kind === "stroke") {
        result = pending.isDrive ? recordStrokeDrive(me, holeForMe, posArg) : recordStrokeNextShot(me, holeForMe, posArg);
      } else {
        result = pending.isDrive
          ? recordBBDrive(pending.teamKey, pending.who, holeForMe, posArg)
          : recordBBShotAtRound(pending.teamKey, pending.who, holeForMe, pending.roundIndex, posArg);
      }
      announceShotResult(result, { speakAloud: true });
    }
  }, []);

  useVoiceCaddy(voiceOn && step === "scoring", handleVoiceCommand, voiceWakeWord);

  /* auto shot-stop detection — scoped to "you" only, see computePendingShot/shotDetectorStep.
     Both formats now use the same per-hole view, so the "current hole" is always whichever hole
     is active there (the player chose it), not whatever GPS thinks is nearest. */
  const myTeeHole = activeHole ? getTeeHole(course, teeIdFor(mePlayerId), activeHole.number) : null;
  const currentHoleForMe = activeHole ? { ...activeHole, teeLat: myTeeHole.teeLat, teeLon: myTeeHole.teeLon } : null;
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
      // handicap/differential math uses whichever tee this player is assigned to, not the
      // course's legacy top-level rating/slope — those two only differ when the course has
      // more than one tee box (see the 13 Aug tee-color feature); teeById() falls back to the
      // course's single/default tee otherwise, so this is a no-op for single-tee courses.
      const tee = teeById(course, teeAssign[pid]);
      const teeSlope = tee?.slope ?? course.slope;
      const teeRating = tee?.rating ?? course.rating;
      const hi = playerHandicapIndex(pid);
      const ch = courseHandicap(hi, teeSlope, teeRating, par);
      const net = gross - ch;
      roundScores[pid] = { holes: holesObj, gross, net, courseHandicap: ch, teeId: tee?.id ?? null, teeName: tee?.name ?? null };

      const rating = teeRating != null ? teeRating : par;
      const slope = teeSlope || 113;
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
      // better ball doesn't use handicap math, but record which tee each player was on for
      // History/consistency with stroke play (see the 13 Aug tee-color feature)
      const teeIds = ids.map((id) => teeAssign[id] || null);
      return { playerIds: ids, teeIds, holeScores, holeDetails, total: complete ? total : total, complete };
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
    setStep("setup"); setSelected([]); setOverrides({}); setScores({}); setTeamAssign({}); setTeeAssign({}); setBbState({ team1: {}, team2: {} });
    setStartHole(1); setActiveIdx(0);
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

        {course && course.holes.some((h) => h.number === 10) && (
          <>
            <div style={{ fontFamily: sans, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: C.turf, margin: "14px 0 8px" }}>Starting hole</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <button style={{ ...btnGhost, background: startHole === 1 ? C.fairway : C.white, color: startHole === 1 ? C.white : C.fairway }} onClick={() => setStartHole(1)}>1st tee</button>
              <button style={{ ...btnGhost, background: startHole === 10 ? C.fairway : C.white, color: startHole === 10 ? C.white : C.fairway }} onClick={() => setStartHole(10)}>10th tee</button>
            </div>
          </>
        )}

        <div style={{ fontFamily: sans, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: C.turf, margin: "14px 0 8px" }}>
          Select {format === "betterball" ? "2 or 4" : "up to 4"} players
        </div>
        <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
          {players.map((p) => {
            const on = selected.includes(p.id);
            const hi = computeHandicapIndex(p.differentials.map((d) => d.value));
            const courseTees = getCourseTees(course);
            const playerTeeId = teeAssign[p.id] || courseTees[0]?.id;
            return (
              <div key={p.id} onClick={() => togglePlayer(p.id)}
                style={{ ...cardStyle, cursor: "pointer",
                  borderColor: on ? C.fairway : C.line, background: on ? C.paper2 : C.white }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
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
                {on && courseTees.length > 1 && (
                  <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
                    <span style={{ fontFamily: sans, fontSize: 11, color: C.turf }}>Tees:</span>
                    <span style={{ width: 9, height: 9, borderRadius: "50%", display: "inline-block", background: courseTees.find((t) => t.id === playerTeeId)?.color || C.turf, border: `1px solid ${C.line}`, flexShrink: 0 }} />
                    <select
                      style={{ ...inputStyle, padding: "4px 6px", fontSize: 12, width: "auto" }}
                      value={playerTeeId}
                      onChange={(e) => setPlayerTee(p.id, e.target.value)}
                    >
                      {courseTees.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                )}
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
        {selected.length === 0 && (
          <div style={{ fontFamily: sans, fontSize: 12, color: C.flag, marginBottom: 10 }}>Select at least one player above to start.</div>
        )}
        <button style={btnPrimary} disabled={selected.length === 0 || !teamsReady} onClick={beginRound}>Start round →</button>
      </div>
    );
  }

  /* ---- scoring: stroke play (per-hole focused view) ---- */
  if (format === "stroke") {
    const totalHoles = playOrder.length;
    const showHalfway = totalHoles === 18;

    function markDriveForStroke(pid) {
      const h = activeHole;
      if (!h) return;
      // override the shared hole's tee anchor with this player's own tee box, if their
      // assigned tee has one (13 Aug tee-color feature) — recordStrokeDrive reads teeLat/teeLon
      // from whichever hole object it's given, so this is a plain call-site substitution
      const pTee = getTeeHole(course, teeIdFor(pid), h.number);
      const hForP = { ...h, teeLat: pTee.teeLat, teeLon: pTee.teeLon };
      setDriveModal({
        hole: hForP,
        label: players.find((p) => p.id === pid)?.name || "Player",
        shotLabel: "drive",
        onSave: (yd, lat, lng) => {
          const result = recordStrokeDrive(pid, hForP, { lat, lon: lng });
          if (pid === mePlayerId) announceShotResult(result, { speakAloud: false });
          setDriveModal(null);
        },
      });
    }
    function markNextShotForStroke(pid) {
      const h = activeHole;
      if (!h) return;
      const pTee = getTeeHole(course, teeIdFor(pid), h.number);
      const hForP = { ...h, teeLat: pTee.teeLat, teeLon: pTee.teeLon };
      const cell = scores[pid]?.[h.number] || {};
      const extra = cell.extraShots || [];
      const prevPt = extra.length ? extra[extra.length - 1] : cell.driveLat != null ? { lat: cell.driveLat, lon: cell.driveLon } : null;
      setDriveModal({
        hole: hForP,
        label: players.find((p) => p.id === pid)?.name || "Player",
        shotLabel: "next shot",
        fromLat: prevPt?.lat, fromLon: prevPt?.lon,
        onSave: (yd, lat, lng) => {
          const result = recordStrokeNextShot(pid, hForP, { lat, lon: lng });
          if (pid === mePlayerId) announceShotResult(result, { speakAloud: false });
          setDriveModal(null);
        },
      });
    }
    function subtotalFor(pid, holesSlice) {
      return holesSlice.reduce((s, h) => s + (Number(scores[pid]?.[h.number]?.gross) || 0), 0);
    }

    const rows = [];
    for (let idx = 0; idx < totalHoles; idx++) {
      const h = playOrder[idx];
      if (idx < activeIdx) {
        rows.push(
          <div
            key={h.number}
            onClick={() => setActiveIdx(idx)}
            style={{ display: "flex", alignItems: "center", padding: "7px 10px", background: idx % 2 === 0 ? C.white : C.paper, borderBottom: `1px solid ${C.line}`, cursor: "pointer", fontFamily: mono }}
          >
            <div style={{ width: 28, fontSize: 13, fontWeight: 700, color: C.ink }}>{h.number}</div>
            <div style={{ width: 26, fontSize: 12, color: C.turf }}>{h.par}</div>
            {selected.map((pid) => {
              const cell = scores[pid]?.[h.number] || {};
              return (
                <div key={pid} style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "center" }}>
                  <ScoreBadge gross={cell.gross} par={h.par} />
                </div>
              );
            })}
          </div>
        );
      } else if (idx === activeIdx) {
        rows.push(
          <StrokeHoleCard
            key={h.number}
            hole={h}
            isLast={idx === totalHoles - 1}
            players={players}
            selected={selected}
            scores={scores}
            distanceUnit={distanceUnit}
            livePos={livePos}
            mePlayer={mePlayer}
            course={course}
            teeAssign={teeAssign}
            onScoreField={setScoreField}
            onMarkDrive={markDriveForStroke}
            onMarkNextShot={markNextShotForStroke}
            onNext={() => setActiveIdx((i) => Math.min(i + 1, totalHoles))}
          />
        );
      }
      if (idx === 8 && showHalfway && idx < activeIdx) {
        rows.push(
          <div key="out" style={{ display: "flex", alignItems: "center", padding: "7px 10px", background: C.line, borderBottom: `1px solid ${C.line}`, fontFamily: mono, fontWeight: 700 }}>
            <div style={{ width: 54, fontSize: 12, color: C.fairwayDark }}>OUT</div>
            {selected.map((pid) => (
              <div key={pid} style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 13 }}>{subtotalFor(pid, playOrder.slice(0, 9))}</div>
            ))}
          </div>
        );
      }
    }
    if (roundComplete) {
      if (showHalfway) {
        rows.push(
          <div key="in" style={{ display: "flex", alignItems: "center", padding: "7px 10px", background: C.line, borderBottom: `1px solid ${C.line}`, fontFamily: mono, fontWeight: 700 }}>
            <div style={{ width: 54, fontSize: 12, color: C.fairwayDark }}>IN</div>
            {selected.map((pid) => (
              <div key={pid} style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 13 }}>{subtotalFor(pid, playOrder.slice(9))}</div>
            ))}
          </div>
        );
      }
      rows.push(
        <div key="total" style={{ display: "flex", alignItems: "center", padding: "9px 10px", background: C.fairway, fontFamily: mono, fontWeight: 700 }}>
          <div style={{ width: 54, fontSize: 12, color: C.white }}>TOTAL</div>
          {selected.map((pid) => (
            <div key={pid} style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 15, color: C.white }}>{subtotalFor(pid, playOrder)}</div>
          ))}
        </div>
      );
    }

    return (
      <div>
        {resumedNotice && (
          <div style={{ background: C.paper2, border: `1px solid ${C.brass}`, borderRadius: 6, padding: "8px 12px", fontFamily: sans, fontSize: 12, color: C.fairway, marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Resumed your in-progress round.</span>
            <button onClick={() => setResumedNotice(false)} style={{ background: "transparent", border: "none", color: C.fairway, cursor: "pointer", fontSize: 14 }}>×</button>
          </div>
        )}
        {/* course name/round type now live in the ribbon's compact header (see App()); Voice
            caddy nests next to the wind panel here instead of sitting in a local heading row,
            and Back to setup lives in the ribbon's hamburger menu — both freeing up vertical
            space on the scoring screen, per the "more room while scoring" request.
            `alignItems: "stretch"` (rather than flex-start) makes the Voice caddy button match
            the wind panel's height exactly, whatever that height ends up being — see
            VoiceCaddyButton's `height: "100%"`. */}
        <div style={{ display: "flex", gap: 8, alignItems: "stretch", marginBottom: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <WindIndicator wind={wind} compass={compass} unit={distanceUnit === "m" ? "kmh" : "mph"} />
          </div>
          <VoiceCaddyButton voiceOn={voiceOn} setVoiceOn={setVoiceOn} voiceMsg={voiceMsg} voiceError={voiceError} voiceUnmatched={voiceUnmatched} setVoiceUnmatched={setVoiceUnmatched} mePlayer={mePlayer} wakeWord={voiceWakeWord} />
        </div>
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden" }}>
          {selected.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", padding: "6px 10px", background: C.fairway, fontFamily: sans, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.03em" }}>
              <div style={{ width: 28, color: C.white }}>#</div>
              <div style={{ width: 26 }} />
              {selected.map((pid) => (
                <div key={pid} style={{ flex: 1, minWidth: 0, textAlign: "center", color: C.white, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {players.find((p) => p.id === pid)?.name}
                </div>
              ))}
            </div>
          )}
          {rows}
        </div>
        {roundComplete && (
          <div style={{ marginTop: 16, textAlign: "right" }}>
            <button style={btnPrimary} onClick={finishStrokeRound}>Finish & save round</button>
          </div>
        )}
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

  /* ---- scoring: better ball (per-hole focused view, same shape as stroke play) ---- */
  const pA1 = players.find((p) => p.id === team1Ids[0]), pB1 = players.find((p) => p.id === team1Ids[1]);
  const pA2 = players.find((p) => p.id === team2Ids[0]), pB2 = players.find((p) => p.id === team2Ids[1]);
  const solo = team2Ids.length === 0;
  const totalHoles = playOrder.length;
  const showHalfway = totalHoles === 18;

  function updateBB(teamKey, holeNumber, nextState) {
    setBbState((prev) => ({ ...prev, [teamKey]: { ...prev[teamKey], [holeNumber]: nextState } }));
  }
  function markDriveForBB(teamKey, h, who, currentState, playerName) {
    const pid = who === "A" ? (teamKey === "team1" ? team1Ids[0] : team2Ids[0]) : (teamKey === "team1" ? team1Ids[1] : team2Ids[1]);
    // same call-site tee override as stroke play's markDriveForStroke — see that function's comment
    const pTee = getTeeHole(course, teeIdFor(pid), h.number);
    const hForP = { ...h, teeLat: pTee.teeLat, teeLon: pTee.teeLon };
    setDriveModal({
      hole: hForP,
      label: playerName || "Player",
      shotLabel: "drive",
      onSave: (yd, lat, lng) => {
        const result = recordBBDrive(teamKey, who, hForP, { lat, lon: lng });
        if (pid === mePlayerId) announceShotResult(result, { speakAloud: false });
        setDriveModal(null);
      },
    });
  }
  function markNextShotForBB(teamKey, h, who, roundIndex, playerName) {
    const pid = who === "A" ? (teamKey === "team1" ? team1Ids[0] : team2Ids[0]) : (teamKey === "team1" ? team1Ids[1] : team2Ids[1]);
    const pTee = getTeeHole(course, teeIdFor(pid), h.number);
    const hForP = { ...h, teeLat: pTee.teeLat, teeLon: pTee.teeLon };
    const s = bbState[teamKey]?.[h.number] || defaultBBHole();
    const driveLatField = who === "A" ? "driveLatA" : "driveLatB";
    const driveLonField = who === "A" ? "driveLonA" : "driveLonB";
    const anchor = roundIndex === 1
      ? s.rounds[0]?.[driveLatField] != null
        ? { lat: s.rounds[0][driveLatField], lon: s.rounds[0][driveLonField] }
        : hForP.teeLat != null ? { lat: hForP.teeLat, lon: hForP.teeLon } : null
      : s.rounds[roundIndex - 1]?.lat != null
      ? { lat: s.rounds[roundIndex - 1].lat, lon: s.rounds[roundIndex - 1].lon }
      : null;
    setDriveModal({
      hole: hForP,
      label: playerName || "Player",
      shotLabel: `shot ${roundIndex + 1}`,
      fromLat: anchor?.lat, fromLon: anchor?.lon,
      onSave: (yd, lat, lng) => {
        const result = recordBBShotAtRound(teamKey, who, hForP, roundIndex, { lat, lon: lng });
        if (pid === mePlayerId) announceShotResult(result, { speakAloud: false });
        setDriveModal(null);
      },
    });
  }
  const t1Total = course.holes.reduce((s, h) => s + (bbHoleScore(bbState.team1?.[h.number]) || 0), 0);
  const t2Total = course.holes.reduce((s, h) => s + (bbHoleScore(bbState.team2?.[h.number]) || 0), 0);
  function bbSubtotalFor(teamKey, holesSlice) {
    return holesSlice.reduce((s, h) => s + (bbHoleScore(bbState[teamKey]?.[h.number]) || 0), 0);
  }

  const rows = [];
  for (let idx = 0; idx < totalHoles; idx++) {
    const h = playOrder[idx];
    if (idx < activeIdx) {
      rows.push(
        <div
          key={h.number}
          onClick={() => setActiveIdx(idx)}
          style={{ display: "flex", alignItems: "center", padding: "7px 10px", background: idx % 2 === 0 ? C.white : C.paper, borderBottom: `1px solid ${C.line}`, cursor: "pointer", fontFamily: mono }}
        >
          <div style={{ width: 28, fontSize: 13, fontWeight: 700, color: C.ink }}>{h.number}</div>
          <div style={{ width: 26, fontSize: 12, color: C.turf }}>{h.par}</div>
          <div style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 15, fontWeight: 700, color: C.team1 }}>{bbHoleScore(bbState.team1?.[h.number]) ?? "–"}</div>
          {!solo && <div style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 15, fontWeight: 700, color: C.team2 }}>{bbHoleScore(bbState.team2?.[h.number]) ?? "–"}</div>}
        </div>
      );
    } else if (idx === activeIdx) {
      rows.push(
        <BetterBallFocusedHole
          key={h.number}
          hole={h}
          isLast={idx === totalHoles - 1}
          solo={solo}
          pA1={pA1} pB1={pB1} pA2={pA2} pB2={pB2}
          team1Ids={team1Ids} team2Ids={team2Ids}
          bbState={bbState}
          distanceUnit={distanceUnit}
          livePos={livePos}
          mePlayerId={mePlayerId}
          mePlayer={mePlayer}
          course={course}
          teeAssign={teeAssign}
          onUpdateTeam1={(s) => updateBB("team1", h.number, s)}
          onUpdateTeam2={(s) => updateBB("team2", h.number, s)}
          onMarkDrive1={(who) => markDriveForBB("team1", h, who, bbState.team1?.[h.number], who === "A" ? pA1?.name : pB1?.name)}
          onMarkShot1={(who, roundIdx) => markNextShotForBB("team1", h, who, roundIdx, who === "A" ? pA1?.name : pB1?.name)}
          onMarkDrive2={(who) => markDriveForBB("team2", h, who, bbState.team2?.[h.number], who === "A" ? pA2?.name : pB2?.name)}
          onMarkShot2={(who, roundIdx) => markNextShotForBB("team2", h, who, roundIdx, who === "A" ? pA2?.name : pB2?.name)}
          onNext={() => setActiveIdx((i) => Math.min(i + 1, totalHoles))}
        />
      );
    }
    if (idx === 8 && showHalfway && idx < activeIdx) {
      rows.push(
        <div key="out" style={{ display: "flex", alignItems: "center", padding: "7px 10px", background: C.line, borderBottom: `1px solid ${C.line}`, fontFamily: mono, fontWeight: 700 }}>
          <div style={{ width: 54, fontSize: 12, color: C.fairwayDark }}>OUT</div>
          <div style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 13, color: C.team1 }}>{bbSubtotalFor("team1", playOrder.slice(0, 9))}</div>
          {!solo && <div style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 13, color: C.team2 }}>{bbSubtotalFor("team2", playOrder.slice(0, 9))}</div>}
        </div>
      );
    }
  }
  if (roundComplete) {
    if (showHalfway) {
      rows.push(
        <div key="in" style={{ display: "flex", alignItems: "center", padding: "7px 10px", background: C.line, borderBottom: `1px solid ${C.line}`, fontFamily: mono, fontWeight: 700 }}>
          <div style={{ width: 54, fontSize: 12, color: C.fairwayDark }}>IN</div>
          <div style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 13, color: C.team1 }}>{bbSubtotalFor("team1", playOrder.slice(9))}</div>
          {!solo && <div style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 13, color: C.team2 }}>{bbSubtotalFor("team2", playOrder.slice(9))}</div>}
        </div>
      );
    }
    rows.push(
      <div key="total" style={{ display: "flex", alignItems: "center", padding: "9px 10px", background: C.fairway, fontFamily: mono, fontWeight: 700 }}>
        <div style={{ width: 54, fontSize: 12, color: C.white }}>TOTAL</div>
        <div style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 15, color: C.white }}>{t1Total}</div>
        {!solo && <div style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 15, color: C.white }}>{t2Total}</div>}
      </div>
    );
  }

  return (
    <div>
      {resumedNotice && (
        <div style={{ background: C.paper2, border: `1px solid ${C.brass}`, borderRadius: 6, padding: "8px 12px", fontFamily: sans, fontSize: 12, color: C.fairway, marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Resumed your in-progress round.</span>
          <button onClick={() => setResumedNotice(false)} style={{ background: "transparent", border: "none", color: C.fairway, cursor: "pointer", fontSize: 14 }}>×</button>
        </div>
      )}
      {/* see the matching comment in the stroke-play branch above — same ribbon-header move,
          same alignItems: "stretch" height-matching */}
      <div style={{ display: "flex", gap: 8, alignItems: "stretch", marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <WindIndicator wind={wind} compass={compass} unit={distanceUnit === "m" ? "kmh" : "mph"} />
        </div>
        <VoiceCaddyButton voiceOn={voiceOn} setVoiceOn={setVoiceOn} voiceMsg={voiceMsg} voiceError={voiceError} voiceUnmatched={voiceUnmatched} setVoiceUnmatched={setVoiceUnmatched} mePlayer={mePlayer} wakeWord={voiceWakeWord} />
      </div>
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
      <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "6px 10px", background: C.fairway, fontFamily: sans, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.03em" }}>
          <div style={{ width: 28, color: C.white }}>#</div>
          <div style={{ width: 26 }} />
          <div style={{ flex: 1, minWidth: 0, textAlign: "center", color: C.white }}>{solo ? "Better Ball" : "Team 1"}</div>
          {!solo && <div style={{ flex: 1, minWidth: 0, textAlign: "center", color: C.white }}>Team 2</div>}
        </div>
        {rows}
      </div>
      {roundComplete && (
        <div style={{ marginTop: 16, textAlign: "right" }}>
          <button style={btnPrimary} onClick={finishBetterBallRound}>Finish & save round</button>
        </div>
      )}
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
            {stats.firAttempts > 0 && (
              /* plain-text fallback for the Fairway/Left/Right breakdown below, always
                 rendered regardless of whether the recharts pie chart renders correctly on
                 this device/browser — some real-device/mobile-browser combinations can fail
                 to size a freshly-mounted ResponsiveContainer correctly, which would silently
                 hide this data if it only lived in the chart */
              <div style={{ fontFamily: sans, fontSize: 12, color: C.ink, marginTop: 4 }}>
                Tee shots: <b style={{ color: C.turf }}>Fairway {stats.shapeCounts.fairway || 0}</b>
                {" · "}<b style={{ color: C.flag }}>Left {stats.shapeCounts.left || 0}</b>
                {" · "}<b style={{ color: C.brass }}>Right {stats.shapeCounts.right || 0}</b>
              </div>
            )}
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
                        <td style={tdStyle}>
                          {putts ?? "—"}
                          {detail?.puttMode === "better" && (
                            <div style={{ fontSize: 10, fontFamily: sans, color: C.turf, fontWeight: 700, whiteSpace: "nowrap" }}>better ball</div>
                          )}
                          {detail?.puttMode === "own" && (
                            <div style={{ fontSize: 10, fontFamily: sans, color: C.turf, fontWeight: 700, whiteSpace: "nowrap" }}>
                              own: {pA?.name || "A"} {detail.ownPutts?.A ?? "—"} · {pB?.name || "B"} {detail.ownPutts?.B ?? "—"}
                            </div>
                          )}
                        </td>
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
  /* null when no round is being actively scored; otherwise { courseName, formatLabel, onBack }
     reported up by PlayTab (see its onActiveRoundChange effect) — drives the ribbon's compact
     "hamburger" header below, only while the Play tab is actually showing the scoring screen */
  const [activeRound, setActiveRound] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const compact = tab === "play" && !!activeRound;

  useEffect(() => { if (!compact) setMenuOpen(false); }, [compact]);

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
      <div style={{ background: C.fairway, padding: "16px 14px 0", position: "relative" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            {/* hamburger: hidden/collapsed (width+opacity animated to 0) outside compact mode,
                rather than unmounted, so it visibly grows in as the tab row collapses below */}
            <button
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Menu"
              aria-expanded={menuOpen}
              style={{
                ...hamburgerBtnStyle,
                width: compact ? 34 : 0,
                opacity: compact ? 1 : 0,
                border: compact ? hamburgerBtnStyle.border : "none",
                transform: compact ? "scale(1)" : "scale(0.4)",
                pointerEvents: compact ? "auto" : "none",
                transition: "width 0.25s ease, opacity 0.2s ease, transform 0.25s ease",
                overflow: "hidden",
              }}
            >
              ☰
            </button>
            {compact ? (
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: serif, fontSize: 16, color: C.white, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {activeRound.courseName}
                </div>
                <div style={{ fontFamily: sans, fontSize: 10, color: "rgba(251,249,242,0.7)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  {activeRound.formatLabel}
                </div>
              </div>
            ) : (
              <div style={{ fontFamily: serif, fontSize: 22, color: C.white }}>Linksman</div>
            )}
          </div>
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
        {/* full tab row collapses to zero height/opacity in compact mode instead of the
            hamburger appearing alongside it — the two visually swap places, "zooming" into
            the hamburger as requested */}
        <div style={{ display: "flex", maxHeight: compact ? 0 : 60, opacity: compact ? 0 : 1, overflow: "hidden", transition: "max-height 0.28s ease, opacity 0.2s ease" }}>
          <Tab label="Play" active={tab === "play"} onClick={() => setTab("play")} />
          <Tab label="Courses" active={tab === "courses"} onClick={() => setTab("courses")} />
          <Tab label="Players" active={tab === "players"} onClick={() => setTab("players")} />
          <Tab label="History" active={tab === "history"} onClick={() => setTab("history")} />
        </div>
        {menuOpen && compact && (
          <NavMenu tab={tab} setTab={setTab} onClose={() => setMenuOpen(false)} activeRound={activeRound} />
        )}
      </div>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "22px 20px 60px" }}>
        {tab === "play" && <PlayTab courses={courses} players={players} setPlayers={setPlayers} rounds={rounds} setRounds={setRounds} distanceUnit={distanceUnit} mePlayerId={mePlayerId} voiceWakeWord={voiceWakeWord} onActiveRoundChange={setActiveRound} />}
        {tab === "courses" && <CoursesTab courses={courses} setCourses={setCourses} location={location} requestLocation={requestLocation} distanceUnit={distanceUnit} />}
        {tab === "players" && <PlayersTab players={players} setPlayers={setPlayers} distanceUnit={distanceUnit} mePlayerId={mePlayerId} setMePlayerId={setMePlayerId} voiceWakeWord={voiceWakeWord} setVoiceWakeWord={setVoiceWakeWord} />}
        {tab === "history" && <HistoryTab rounds={rounds} players={players} courses={courses} distanceUnit={distanceUnit} />}
      </div>
    </div>
  );
}
