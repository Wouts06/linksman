// Vercel serverless function — proxies Overpass API (hole-by-hole golf course geometry)
// server-side, for the same reason as api/osm-search.js: a browser fetch() can never send a
// real User-Agent, and Overpass's anti-abuse rules (HTTP 406 responses are a known, widespread,
// currently-active issue on public Overpass mirrors) treat unidentified/generic-PaaS-domain
// browser traffic worse than an identified server-side client.
//
// Usage: GET /api/osm-holes?south=<lat>&north=<lat>&west=<lon>&east=<lon>
//     or: GET /api/osm-holes?osmType=way|relation&osmId=<id>&south=...&north=...&west=...&east=...
// Returns: the raw Overpass JSON (the `elements` array), unchanged, so the client-side
// parseOSMHoleElements() logic doesn't need to know anything moved. Tries each mirror in turn
// before giving up, exactly like the old client-side fallback did.
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

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter", // most reliable public mirror as of 2026
  "https://overpass.private.coffee/api/interpreter", // independent mirror
];

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
        return `[out:json][timeout:25];(way["golf"="hole"](${south},${west},${north},${east}););out geom;`;
      })()
    : null;

  if (!hasArea && !hasBbox) {
    res.status(400).json({ error: "Need either osmType+osmId or south/north/west/east" });
    return;
  }

  if (hasArea) {
    const ref = osmType === "way" ? `way(${osmId})` : `relation(${osmId})`;
    const areaQuery = `[out:json][timeout:25];${ref};map_to_area->.a;way["golf"="hole"](area.a);out geom;`;
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
