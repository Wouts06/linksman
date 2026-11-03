// Vercel serverless function — proxies Overpass API (hole-by-hole golf course geometry)
// server-side, for the same reason as api/osm-search.js: a browser fetch() can never send a
// real User-Agent, and Overpass's anti-abuse rules (HTTP 406 responses are a known, widespread,
// currently-active issue on public Overpass mirrors) treat unidentified/generic-PaaS-domain
// browser traffic worse than an identified server-side client.
//
// Usage: GET /api/osm-holes?south=<lat>&north=<lat>&west=<lon>&east=<lon>
//     or: GET /api/osm-holes?osmType=way|relation&osmId=<id>&south=...&north=...&west=...&east=...
// Returns: an Overpass-shaped `{elements: [...]}` payload, so the client-side
// parseOSMHoleElements() logic doesn't need to know anything moved — as of 3 Nov, that payload
// can come from either OSM's own primary API (tried first when a bbox is given, see
// fetchFromPrimaryAPI below — always-fresh, no mirror involved) or Overpass itself, converted
// to look identical either way. Tries each Overpass mirror in turn before giving up, exactly
// like the old client-side fallback did.
//
// When osmType/osmId identify the specific course (a way or relation, i.e. anything with real
// mapped geometry — not a bare node), the query is restricted to holes actually WITHIN that
// course's own mapped area via Overpass's `map_to_area`, instead of a plain bounding-box scan.
// This matters because a bounding box (especially the generous fixed padding used by the
// "find courses near me" flow, which only has a center point to work from) can sweep in
// `golf=hole` ways belonging to a different, geographically close course — observed in practice
// as a course reporting double (or a handful extra) the holes it actually has. Falls back to
// the bounding-box query when no osmType/osmId is given, or the course is only a bare node
// (no area to restrict to).
//
// Also fetches `golf=tee` elements (nodes and small areas) alongside `golf=hole` ways (13 Aug,
// tee-box color-detection round) — some OpenStreetMap mappers place one tee marker per physical
// tee box per hole, colour-tagged via `tee=<colour>` (e.g. `tee=red`; see the OSM wiki's
// Tag:golf=tee page). The client (parseOSMHoleElements/buildOSMTeeSets in App.jsx) groups these
// by color into named tee sets with real per-tee GPS and yardage. Not every course has this
// level of detail mapped — most only have the single golf=hole line this app already used —
// so an empty teeBoxes result is the common case, not a bug.
//
// Also fetches `golf=green` elements (14 Aug, tee/green back-edge round) — the actual green
// polygon shape, distinct from (and usually more precise than) the golf=hole line's own end
// vertex. When present, the client uses these polygons to compute a real "back of the green"
// point (and, live during a round, to recompute which polygon vertex counts as "back" from the
// player's current position/angle of approach) instead of a single fixed point. Same
// not-every-course caveat applies — an empty green-polygon result is common and not a bug.
//
// Also fetches `golf=bunker`, `golf=water_hazard`, and `golf=lateral_water_hazard` elements
// (3 Nov, bunker-distance round) — bunker outlines and hazard outlines, same polygon shape as
// greens. Bunkers are tagged as ways per the OSM wiki (nodes are discouraged but still occur in
// the wild on some tiny/unmapped-as-area bunkers, so both are queried); hazards are ways. The
// client (parseOSMHoleElements in App.jsx) matches each polygon to its nearest hole the same way
// it already matches green polygons, and reuses the existing nearest/farthest-vertex distance
// math for "distance to front/back of bunker" instead of new math. Per the wiki, OSM does not
// group these under a parent relation the way `golf=hole` can be grouped under `golf=course` —
// their course membership is implied purely by location — so coverage is noticeably patchier
// than tees/greens for courses that are only lightly mapped. An empty result is common, not a bug.

// Reordered 3 Nov (reliability round) — overpass.kumi.systems, previously listed first, has
// been reported (OSM community forum, Mar 2026) to be serving corrupted/severely outdated data,
// which is a worse failure mode than an outright error: runQuery below returns the FIRST mirror
// that responds 200, with no way to tell a stale answer from a fresh one, so a bad mirror earlier
// in this list can silently mask a working one later in it. Dropped entirely rather than kept as
// a lower-priority fallback, since serving stale data is exactly the complaint this round is
// fixing. overpass.private.coffee goes first: it's run by a non-profit specifically advertising
// "no rate limit" (vs. overpass-api.de's documented <10,000 req/day cap and its own well-known,
// ongoing reliability problems since late 2025 — frequent 504s/timeouts under load). overpass-
// api.de stays as a last-resort fallback purely for mirror diversity.
const OVERPASS_ENDPOINTS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

// Every golf=* tag/geometry combination this endpoint fetches. Centralized here so the area
// query and the bounding-box query (below) can't drift out of sync with each other.
const GOLF_FILTERS = [
  { type: "way", value: "hole" },
  { type: "node", value: "tee" },
  { type: "way", value: "tee" },
  { type: "node", value: "green" },
  { type: "way", value: "green" },
  { type: "way", value: "bunker" },
  { type: "node", value: "bunker" }, // discouraged by the wiki but seen in practice; harmless to include
  { type: "way", value: "water_hazard" },
  { type: "way", value: "lateral_water_hazard" },
];

function buildFilters(scope) {
  return GOLF_FILTERS.map(({ type, value }) => `${type}["golf"="${value}"]${scope};`).join("");
}

// The exact golf=* values this endpoint cares about, derived from GOLF_FILTERS — used below to
// filter the primary API's unfiltered bbox dump down to just these, client-side.
const GOLF_VALUES = new Set(GOLF_FILTERS.map((f) => f.value));

// Maximum bbox area (square degrees) to try against the primary API before falling back
// straight to Overpass — OSM's own documented cap is 0.25; this stays comfortably under it
// since the cap "may change at any time" per the wiki, and every real caller here is a single
// course's own small box anyway (a golf course bbox padded generously is still only ~0.002-0.01
// square degrees — this ceiling is a safety net for an unexpectedly large box, not a normal case).
const PRIMARY_API_MAX_AREA = 0.2;

/* Tries OpenStreetMap's own primary API (the same one iD/JOSM editors read and write through)
   directly, instead of Overpass, for a small bounding box (3 Nov, reliability round). Added
   because of two separate, real problems with the three Overpass mirrors above: (1) they've had
   documented reliability issues (timeouts, 504s) since late 2025, and (2) — the one that actually
   explains "OSM shows my edit but the app doesn't" — Overpass mirrors only re-sync from the main
   database on their own periodic schedule (typically described as "a couple of minutes" but
   observed, in practice, to be anywhere from minutely to once-daily depending on the mirror), so
   a change made moments ago on osm.org can be genuinely absent from every Overpass mirror for a
   while. The primary API has neither problem: it reads the same live database the website itself
   writes to, with no replication step at all, and it's officially intended for exactly this kind
   of small-area read (that's what every OSM editor's "download this bit of the map" button
   calls). The tradeoff is it can't do Overpass's `map_to_area` trick (no "restrict to just this
   course's own mapped area"), only a plain bbox — same shape as this file's existing bbox
   fallback, so nothing is lost there — and it returns EVERY element in the box, not just
   golf-tagged ones, hence the client-side filtering below. This is tried FIRST, before the
   area/bbox Overpass logic in the handler, and only that existing logic runs if this comes back
   empty or fails, so nothing about the Overpass path changes or gets worse. */
async function fetchFromPrimaryAPI(south, north, west, east) {
  const area = (north - south) * (east - west);
  if (!(area > 0) || area > PRIMARY_API_MAX_AREA) return null;
  try {
    const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${west},${south},${east},${north}`;
    const upstream = await fetch(url, {
      headers: {
        Accept: "application/json",
        // Deliberately no contact email here (unlike the Overpass/Nominatim proxies above,
        // written before this app had a policy against sending it to a third party by default)
        // — a generic client identifier is all the primary API's own usage policy actually asks
        // for; this hits a different host than those two, so it gets a fresh, policy-correct UA
        // rather than copying theirs.
        "User-Agent": "Linksman-Golf-App/1.0 (personal golf scoring app)",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) return null; // 400 (bbox too large), 509 (too much data), 5xx, etc. — fall back to Overpass
    const data = await upstream.json();
    const rawElements = data.elements || [];

    // Resolve way geometry by hand: the primary API gives each way as a list of node IDs, not
    // inline coordinates (unlike Overpass's `out geom`), but it DOES include every node those
    // ways reference as its own element in the same flat array — so a node-id -> {lat, lon} map
    // built from them is all that's needed to reconstruct the same `geometry` shape Overpass
    // produces, which is the only reason parseOSMHoleElements (App.jsx) doesn't need to know or
    // care which upstream actually answered this request.
    const nodeCoords = new Map();
    for (const el of rawElements) {
      if (el.type === "node" && el.lat != null && el.lon != null) nodeCoords.set(el.id, { lat: el.lat, lon: el.lon });
    }

    const elements = [];
    for (const el of rawElements) {
      const golfValue = el.tags && el.tags.golf;
      if (!golfValue || !GOLF_VALUES.has(golfValue)) continue;
      if (el.type === "node") {
        elements.push({ type: "node", id: el.id, lat: el.lat, lon: el.lon, tags: el.tags });
      } else if (el.type === "way") {
        const geometry = (el.nodes || []).map((id) => nodeCoords.get(id)).filter(Boolean);
        if (!geometry.length) continue; // referenced nodes weren't in this bbox response — can't place it
        elements.push({ type: "way", id: el.id, tags: el.tags, geometry });
      }
    }
    return { elements };
  } catch (e) {
    return null; // network error, timeout, bad JSON — fall back to Overpass
  }
}

async function runQuery(query) {
  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const upstream = await fetch(endpoint, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json, */*",
          "Accept-Language": "en-US",
          // Identifies this app to Overpass, same rationale as the Nominatim proxy above.
          "User-Agent": "Linksman-Golf-App/1.0 (personal golf scoring app; contact: wouter0006@gmail.com)",
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!upstream.ok) {
        lastError = new Error(`Overpass ${endpoint} responded ${upstream.status}`);
        continue; // try the next mirror — 406/429/504 here is transient/anti-abuse, not "no data"
      }
      return { data: await upstream.json(), error: null };
    } catch (e) {
      lastError = e; // network error or our own timeout — try the next mirror
    }
  }
  return { data: null, error: lastError };
}

export default async function handler(req, res) {
  const osmType = (req.query.osmType || "").toString();
  const osmId = Number(req.query.osmId);
  const hasArea = (osmType === "way" || osmType === "relation") && !Number.isNaN(osmId);

  const bboxNums = ["south", "north", "west", "east"].map((k) => Number(req.query[k]));
  const hasBbox = !bboxNums.some((n) => Number.isNaN(n));
  const bboxQuery = hasBbox
    ? (() => {
        const [south, north, west, east] = bboxNums;
        return `[out:json][timeout:25];(${buildFilters(`(${south},${west},${north},${east})`)});out geom;`;
      })()
    : null;

  if (!hasArea && !hasBbox) {
    res.status(400).json({ error: "Need either osmType+osmId or south/north/west/east" });
    return;
  }

  // Try the live primary API first (see fetchFromPrimaryAPI above) — covers the common case
  // (every real caller sends a bbox) with always-fresh data and no Overpass mirror involved at
  // all. Only falls through to the Overpass logic below when this comes back empty/unusable, so
  // a course with nothing mapped yet, or a bbox over the size cap, behaves exactly as before.
  if (hasBbox) {
    const [south, north, west, east] = bboxNums;
    const primary = await fetchFromPrimaryAPI(south, north, west, east);
    if (primary && primary.elements.length > 0) {
      res.status(200).json(primary);
      return;
    }
  }

  if (hasArea) {
    const ref = osmType === "way" ? `way(${osmId})` : `relation(${osmId})`;
    const areaQuery = `[out:json][timeout:25];${ref};map_to_area->.a;(${buildFilters("(area.a)")});out geom;`;
    const areaResult = await runQuery(areaQuery);
    if (areaResult.data && (areaResult.data.elements || []).length > 0) {
      res.status(200).json(areaResult.data);
      return;
    }
    // Area query came back empty (or every mirror failed) — the course's OSM geometry might
    // not form a clean closed polygon `map_to_area` can use. Fall back to the bounding-box
    // scan so a structurally-odd-but-real course doesn't lose its hole data entirely.
    if (hasBbox) {
      const bboxResult = await runQuery(bboxQuery);
      if (bboxResult.data) {
        res.status(200).json(bboxResult.data);
        return;
      }
      res.status(502).json({ error: "All Overpass endpoints failed", detail: bboxResult.error ? bboxResult.error.message : null });
      return;
    }
    // No bbox to fall back to — return the area query's own answer (even if empty/errored),
    // it's the best information we have.
    if (areaResult.data) {
      res.status(200).json(areaResult.data);
    } else {
      res.status(502).json({ error: "All Overpass endpoints failed", detail: areaResult.error ? areaResult.error.message : null });
    }
    return;
  }

  const bboxResult = await runQuery(bboxQuery);
  if (bboxResult.data) {
    res.status(200).json(bboxResult.data);
  } else {
    res.status(502).json({ error: "All Overpass endpoints failed", detail: bboxResult.error ? bboxResult.error.message : null });
  }
}
