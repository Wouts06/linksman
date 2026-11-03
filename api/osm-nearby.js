// Vercel serverless function — finds golf courses near a given point via Overpass API,
// for the same reason as api/osm-search.js and api/osm-holes.js: browser fetch() can never
// send a real User-Agent, and Overpass's anti-abuse rules treat unidentified/generic-PaaS
// browser traffic worse than an identified server-side client.
//
// Usage: GET /api/osm-nearby?lat=<lat>&lon=<lon>&radius=<meters>
// Returns: { elements: [...] } — same shape as Overpass's own JSON output, so the client-side
// parsing logic (mirrors searchOSMCourses' Nominatim parsing) stays simple. Each element has
// tags.name (when mapped) and either lat/lon (nodes) or a center {lat, lon} (ways/relations,
// via `out center;`).

// Reordered 3 Nov (reliability round, same fix as api/osm-holes.js — see that file's longer
// comment for the full reasoning) — overpass.kumi.systems dropped after community reports of it
// serving stale/corrupted data, overpass.private.coffee (no rate limit) goes first, overpass-
// api.de (documented <10,000 req/day cap, ongoing reliability issues since late 2025) stays as a
// last resort. No primary-API fast path here unlike osm-holes.js: this endpoint searches a 40km
// (up to 80km) radius around a point, which is a much bigger area than the OSM primary API's
// bbox-size cap allows, and that API has no "search within a radius" query at all — Overpass's
// `around:` is genuinely the only free tool for this specific query shape.
//
// Third mirror added same day, same round, after live testing showed BOTH of the above failing
// at once (private.coffee timing out completely, overpass-api.de returning HTTP 502) — confirmed
// via the OSM wiki's own current "Public Overpass API instances" table (not secondhand reports
// this time) as the one other free, worldwide-coverage, no-stated-rate-limit instance available:
// run by VK (maps.mail.ru), a large Russian internet company. Worth knowing, not worth avoiding
// for a personal golf app — it's just another public mirror, same trust model as the other two.
const OVERPASS_ENDPOINTS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

export default async function handler(req, res) {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Math.min(Math.max(Number(req.query.radius) || 40000, 1000), 80000); // clamp 1-80km
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    res.status(400).json({ error: "Missing/invalid lat, lon parameters" });
    return;
  }

  const query = `[out:json][timeout:25];nwr["leisure"="golf_course"](around:${radius},${lat},${lon});out center tags;`;

  // Collects EVERY mirror's own failure (3 Nov, diagnostics round) rather than just the last one
  // — a single `lastError` silently threw away the first mirror's actual reason every time a
  // later one also failed, which made a real "both mirrors failing right now" situation look
  // identical to "the last mirror alone is having a bad day" in the error response. Needed this
  // to figure out what's actually going wrong after reordering the mirrors didn't fix it.
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
          "User-Agent": "Linksman-Golf-App/1.0 (personal golf scoring app; contact: wouter0006@gmail.com)",
        },
        // Trimmed from 20s to 12s per mirror (3 Nov, third-mirror round) — with 3 mirrors now
        // tried in sequence, a full round of failures at the old 20s each could take up to a
        // minute; 12s keeps a worst case under 40s while still being generous for a normal
        // response (Overpass queries here are small and typically answer in well under a second
        // when a mirror is healthy — the only time this limit matters is a mirror that's already
        // struggling, i.e. exactly the case being guarded against).
        signal: AbortSignal.timeout(12000),
      });
      if (!upstream.ok) {
        errors.push(`${endpoint} -> HTTP ${upstream.status}`);
        continue; // try the next mirror — 406/429/504 here is transient/anti-abuse, not "no data"
      }
      const data = await upstream.json();
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
      res.status(200).json(data);
      return;
    } catch (e) {
      errors.push(`${endpoint} -> ${e && e.name === "TimeoutError" ? "timed out" : (e && e.message) || "unknown error"}`);
    }
  }
  res.status(502).json({
    error: "All Overpass endpoints failed",
    detail: errors.join("; "),
  });
}
