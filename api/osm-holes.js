// Vercel serverless function — proxies Overpass API (hole-by-hole golf course geometry)
// server-side, for the same reason as api/osm-search.js: a browser fetch() can never send a
// real User-Agent, and Overpass's anti-abuse rules (HTTP 406 responses are a known, widespread,
// currently-active issue on public Overpass mirrors) treat unidentified/generic-PaaS-domain
// browser traffic worse than an identified server-side client.
//
// Usage: GET /api/osm-holes?south=<lat>&north=<lat>&west=<lon>&east=<lon>
// Returns: the raw Overpass JSON (the `elements` array), unchanged, so the client-side
// parseOSMHoleElements() logic doesn't need to know anything moved. Tries each mirror in turn
// before giving up, exactly like the old client-side fallback did.

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter", // most reliable public mirror as of 2026
  "https://overpass.private.coffee/api/interpreter", // independent mirror
];

export default async function handler(req, res) {
  const nums = ["south", "north", "west", "east"].map((k) => Number(req.query[k]));
  if (nums.some((n) => Number.isNaN(n))) {
    res.status(400).json({ error: "Missing/invalid south, north, west, east parameters" });
    return;
  }
  const [south, north, west, east] = nums;
  const query = `[out:json][timeout:25];(way["golf"="hole"](${south},${west},${north},${east}););out geom;`;

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
      const data = await upstream.json();
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
