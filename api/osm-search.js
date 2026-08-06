// Vercel serverless function — proxies Nominatim (OpenStreetMap place search) server-side.
//
// Why this exists: a browser's JS `fetch()` can NEVER set a custom User-Agent header (it's a
// browser-enforced restriction), but Nominatim's usage policy requires one that identifies the
// calling application. Generic `*.vercel.app`/`*.netlify.app` browser traffic with no real
// User-Agent is known to get rate-limited/blocked more aggressively than an identified client.
// Running the request from this server-side function instead lets us send a real, honest
// User-Agent, and makes the browser's own request same-origin (no CORS exposure either).
//
// Usage: GET /api/osm-search?q=<search text>
// Returns: the raw Nominatim JSON array, unchanged, so the client-side parsing logic doesn't
// need to know anything moved.

export default async function handler(req, res) {
  const q = (req.query.q || "").toString().trim();
  if (!q) {
    res.status(400).json({ error: "Missing q parameter" });
    return;
  }

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=1&q=${encodeURIComponent(q)}`;

  try {
    const upstream = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Language": "en-US",
        // Identifies this app per Nominatim's usage policy:
        // https://operations.osmfoundation.org/policies/nominatim/
        "User-Agent": "Linksman-Golf-App/1.0 (personal golf scoring app; contact: wouter0006@gmail.com)",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Nominatim responded ${upstream.status}` });
      return;
    }

    const data = await upstream.json();
    // Light caching at the edge is fine — course search results don't change minute to minute —
    // and keeps us well under Nominatim's "max 1 request/sec" usage policy under repeat searches.
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: e && e.message ? e.message : "Nominatim request failed" });
  }
}
