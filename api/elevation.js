// Vercel serverless function — proxies point elevation lookups from OpenTopoData's free public
// API, for the rangefinder's "plays as" uphill/downhill distance adjustment (16 Aug). Routed
// through our own server for the same reason as the osm-*/wind proxies in this folder: one less
// external-API assumption (CORS, User-Agent, rate limits) left unverified client-side.
//
// Dataset: srtm30m (~30m resolution, latitudes -60 to 60 — covers South Africa and the vast
// majority of golf-course latitudes worldwide). Copernicus GLO-30 was the first choice discussed
// for this feature, but isn't hosted on OpenTopoData's free public tier (only self-hosted/paid
// instances offer it) — srtm30m is the same resolution class and is available for free with no
// API key, so it's the practical substitute. Good enough to tell "the green sits ~4m higher than
// where you're standing," which is all this feature needs — not survey-grade precision.
//
// OpenTopoData's public API is rate-limited (100 locations/request, 1 request/second, 1000
// requests/day) — deliberately not a concern for a single-user app checking a handful of times
// per hole, but the aggressive Cache-Control below means repeat lookups at the same rounded
// coordinates (e.g. a course's fixed green location, looked up across multiple holes played over
// time) are served from Vercel's edge cache instead of hitting OpenTopoData again — elevation
// data never changes, so there's no freshness tradeoff in caching it hard.
//
// Usage: GET /api/elevation?locations=<lat>,<lon>|<lat>,<lon>|...  (same pipe-separated format
// OpenTopoData itself uses, passed straight through — lets the client batch the "from" and "to"
// points into a single request when both are needed).
// Returns: OpenTopoData's own JSON response shape, i.e. { results: [{ elevation, location: {
// lat, lng } }, ...], status: "OK" }.

export default async function handler(req, res) {
  const locations = typeof req.query.locations === "string" ? req.query.locations : "";
  // basic shape validation: one or more "lat,lon" pairs separated by "|" — reject anything else
  // rather than blindly forwarding a malformed/oversized string upstream
  const pairs = locations.split("|").filter(Boolean);
  const valid =
    pairs.length > 0 &&
    pairs.length <= 100 &&
    pairs.every((p) => {
      const parts = p.split(",");
      return parts.length === 2 && parts.every((n) => n.trim() !== "" && !Number.isNaN(Number(n)));
    });
  if (!valid) {
    res.status(400).json({ error: "Missing/invalid 'locations' parameter — expected 'lat,lon' or 'lat,lon|lat,lon|...' (max 100 pairs)" });
    return;
  }

  const url = `https://api.opentopodata.org/v1/srtm30m?locations=${encodeURIComponent(locations)}`;

  try {
    const upstream = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Linksman-Golf-App/1.0 (personal golf scoring app; contact: wouter0006@gmail.com)",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `OpenTopoData responded ${upstream.status}` });
      return;
    }
    const data = await upstream.json();
    // elevation is effectively permanent data — cache hard (1 day at the edge, serve stale for
    // much longer while revalidating) to keep well under OpenTopoData's daily request quota
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: "Failed to reach OpenTopoData", detail: e ? e.message : null });
  }
}
