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
// Third mirror added same day, same round (see api/osm-nearby.js's longer comment on this one)
// — live testing showed both mirrors above failing at once, so a third, confirmed-current free
// worldwide instance (VK/maps.mail.ru) was added from the OSM wiki's own instance table.
const OVERPASS_ENDPOINTS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// Every golf=* tag/geometry combination this endpoint fetches. Centralized here so the area
// query and the bounding-box query (below) can't drift out of sync with each other.
const GOLF_FILTERS = [
  { type: "way", value: "hole" },
  { type: "node", value: "tee" },
  { type: "way", value: "tee" },
  { type: "node", value: "green" },
  { type: "way", value: "green" },
  { type: "relation", value: "green" }, // defensive -- same multipolygon reasoning as water_hazard below
  { type: "way", value: "bunker" },
  { type: "node", value: "bunker" }, // discouraged by the wiki but seen in practice; harmless to include
  { type: "relation", value: "bunker" }, // defensive -- same multipolygon reasoning as water_hazard below
  { type: "way", value: "water_hazard" },
  // 6 Nov (relation round) -- confirmed real via a user screenshot of the OSM "Edit feature" tag
  // panel: their pond is tagged golf=water_hazard + natural=water + type=multipolygon, i.e. it's
  // a RELATION, not a plain way. A multipolygon is OSM's standard way to map an area assembled
  // from more than one way (an island/hole in the middle, or just several ways stitched into one
  // ring) -- nothing below ever fetched relations before this, on either the primary-API path or
  // the Overpass path, so a hazard mapped this way was completely invisible to every query this
  // file ran, regardless of bbox size/padding. That ruled out the padding theory for this
  // specific case even though padding separately mattered for other features.
  { type: "relation", value: "water_hazard" },
  { type: "way", value: "lateral_water_hazard" },
  { type: "relation", value: "lateral_water_hazard" }, // same reasoning as water_hazard above
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

    // Resolve geometry for EVERY way in the response, not just golf-tagged ones (6 Nov, relation
    // round) — a relation's own element never carries inline coordinates, only a list of member
    // {type, ref, role} entries, so resolving a relation's shape means looking up its member way
    // IDs here. Most ways in a bbox dump aren't relation members and this map is cheap, so it's
    // simplest to just resolve all of them once up front rather than resolving on demand per
    // relation.
    const wayGeometry = new Map();
    for (const el of rawElements) {
      if (el.type === "way") {
        const geometry = (el.nodes || []).map((id) => nodeCoords.get(id)).filter(Boolean);
        if (geometry.length) wayGeometry.set(el.id, geometry);
      }
    }

    const elements = [];
    for (const el of rawElements) {
      const golfValue = el.tags && el.tags.golf;
      if (!golfValue || !GOLF_VALUES.has(golfValue)) continue;
      if (el.type === "node") {
        elements.push({ type: "node", id: el.id, lat: el.lat, lon: el.lon, tags: el.tags });
      } else if (el.type === "way") {
        const geometry = wayGeometry.get(el.id);
        if (!geometry || !geometry.length) continue; // referenced nodes weren't in this bbox response — can't place it
        elements.push({ type: "way", id: el.id, tags: el.tags, geometry });
      } else if (el.type === "relation") {
        // Confirmed real via user screenshot: a water hazard mapped as a multipolygon relation
        // (golf=water_hazard + natural=water + type=multipolygon), not a plain way. Concatenate
        // the "outer"-role member ways' own geometry (each resolved via wayGeometry above) into
        // one flat array and emit it AS a "way" element — shape-compatible with the plain-way
        // case above, so the client's existing per-polygon logic (collectPolygons etc. in
        // App.jsx, which only ever filters on tags.golf, never on element type) needs zero
        // changes to consume it.
        const members = el.members || [];
        const outerIds = members.filter((m) => m.type === "way" && m.role === "outer").map((m) => m.ref);
        // Fall back to every member way if none is explicitly tagged "outer" — some mappers leave
        // the role blank on a simple single-ring multipolygon, and an untagged-role way is still
        // almost always the one ring that matters for a small course feature like this.
        const idsToUse = outerIds.length ? outerIds : members.filter((m) => m.type === "way").map((m) => m.ref);
        const geometry = idsToUse.flatMap((id) => wayGeometry.get(id) || []);
        if (!geometry.length) continue; // member ways weren't in this bbox response — can't place it
        elements.push({ type: "way", id: el.id, tags: el.tags, geometry });
      }
    }
    return { elements };
  } catch (e) {
    return null; // network error, timeout, bad JSON — fall back to Overpass
  }
}

// Overpass's own `out geom;` shape for a relation is nested one level deeper than for a way: a
// relation element carries `members: [{type, ref, role, geometry: [{lat, lon}, ...]}, ...]`, with
// each member way's own coordinates inlined under THAT member, not a flat top-level `.geometry`
// on the relation itself (6 Nov, relation round — same water-hazard-as-multipolygon case as
// fetchFromPrimaryAPI above, just normalizing the other upstream's different response shape for
// the same fix). Flattens that into the same `{type:"way", id, tags, geometry}` shape used
// everywhere else in this file, so the client never has to know which upstream answered, or that
// a "way" element it received started life as a relation.
function flattenOverpassRelations(data) {
  if (!data || !Array.isArray(data.elements)) return data;
  const elements = data.elements.map((el) => {
    if (el.type !== "relation") return el;
    const members = el.members || [];
    const outer = members.filter((m) => m.type === "way" && m.role === "outer" && Array.isArray(m.geometry));
    const chosen = outer.length ? outer : members.filter((m) => m.type === "way" && Array.isArray(m.geometry));
    const geometry = chosen.flatMap((m) => m.geometry);
    if (!geometry.length) return el; // nothing resolvable — leave as-is, downstream filters on tags.golf anyway
    return { type: "way", id: el.id, tags: el.tags, geometry };
  });
  return { ...data, elements };
}

async function runQuery(query) {
  // Collects EVERY mirror's own failure, not just the last one (3 Nov, diagnostics round, same
  // fix as api/osm-nearby.js — see that file's comment) — a single overwritten lastError made
  // "every mirror is actually failing" indistinguishable from "only the last one had a bad day"
  // in the error response, which mattered once both current mirrors started failing at once.
  const errors = [];
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
        // Trimmed from 20s to 12s per mirror (3 Nov, third-mirror round — see api/osm-nearby.js's
        // comment on the same change). Matters even more here: the handler below can call
        // runQuery TWICE in the worst case (an area query, then a bbox fallback if that comes
        // back empty), on top of the primary-API attempt that runs first — at the old 20s per
        // mirror that's up to 2 minutes of sequential waiting before giving up entirely.
        signal: AbortSignal.timeout(12000),
      });
      if (!upstream.ok) {
        errors.push(`${endpoint} -> HTTP ${upstream.status}`);
        continue; // try the next mirror — 406/429/504 here is transient/anti-abuse, not "no data"
      }
      return { data: flattenOverpassRelations(await upstream.json()), error: null };
    } catch (e) {
      errors.push(`${endpoint} -> ${e && e.name === "TimeoutError" ? "timed out" : (e && e.message) || "unknown error"}`);
    }
  }
  return { data: null, error: errors.length ? new Error(errors.join("; ")) : null };
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
