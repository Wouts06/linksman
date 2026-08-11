// Vercel serverless function — proxies current wind conditions from Open-Meteo's free forecast
// API. Routed through our own server for the same reason as the osm-* proxies in this folder:
// one less external-API assumption (CORS policy, User-Agent handling, rate limits) left
// unverified client-side, after the OSM Nominatim/Overpass lesson earlier in this project. Open
// Meteo needs no API key for non-commercial use.
//
// Usage: GET /api/wind?lat=<lat>&lon=<lon>&unit=mph|kmh
// Returns: Open-Meteo's own JSON response shape, i.e. { current: { wind_speed_10m,
// wind_direction_10m, wind_gusts_10m, ... }, current_units: {...}, ... } — wind_direction_10m is
// standard meteorological convention: degrees clockwise from true north, the direction the wind
// is blowing FROM (0/360=N, 90=E, 180=S, 270=W).

export default async function handler(req, res) {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const unit = req.query.unit === "kmh" ? "kmh" : "mph";
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    res.status(400).json({ error: "Missing/invalid lat, lon parameters" });
    return;
  }

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=${unit}&timezone=auto`;

  try {
    const upstream = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Linksman-Golf-App/1.0 (personal golf scoring app; contact: wouter0006@gmail.com)",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Open-Meteo responded ${upstream.status}` });
      return;
    }
    const data = await upstream.json();
    // the underlying model only updates ~every 15 minutes, so a short edge cache is free
    // freshness with no real staleness risk
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: "Failed to reach Open-Meteo", detail: e ? e.message : null });
  }
}
