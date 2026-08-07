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

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter", // most reliable public mirror as of 2026
  "https://overpass.private.coffee/api/interpreter", // independent mirror
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
          "User-Agent": "Linksman-Golf-App/1.0 (personal golf scoring app; contact: wouter0006@gmail.com)",
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!upstream.ok) {
        lastError = new Error(`Overpass ${endpoint} responded ${upstream.status}`);
        continue; // try the next mirror — 406/429/504 here is transient/anti-abuse, not "no data"
      }
      const data = await upstream.json();
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
      res.status(200).json(data);
      return;
    } catch (e) {
      lastError = e; // network error or our own timeout — try the next mirror
    }
  }
  res.status(502).json({
    error: "All Overpass endpoints failed",
    detail: lastError ? lastError.message : null,
  });
}
