// Vercel serverless function — proxies course rating/slope lookups from GolfCourseAPI
// (https://api.golfcourseapi.com), 19 Aug. Routed server-side for the same reason as every other
// proxy in this folder (osm-search/osm-nearby/osm-holes/elevation): keeps a secret off the client
// bundle. This one matters more than most — GolfCourseAPI's key is a real per-account credential
// tied to a request quota (free tier: 50/day), not an anonymous public API, so it must never ship
// in browser JS where anyone could read it out of the network tab and burn (or abuse) the quota.
//
// Requires a GOLFCOURSEAPI_KEY environment variable set in the Vercel project (Settings ->
// Environment Variables) — NOT committed to the repo. Returns 501 with a clear message if it's
// missing, rather than a confusing generic failure, since this is the one manual setup step a
// fresh deploy needs that the other proxies in this folder don't.
//
// Usage: GET /api/course-rating?q=<course or club name>
// Returns: GolfCourseAPI's own /v1/search response shape unchanged, i.e. { courses: [{ id,
// club_name, course_name, location, tees: { male: [...], female: [...] } }, ...] } — each tee
// carries tee_name/course_rating/slope_rating/total_yards/par_total/holes. See the OpenAPI spec
// the user pulled from GolfCourseAPI's docs (19 Aug) for the full schema.

export default async function handler(req, res) {
  const q = (req.query.q || "").toString().trim();
  if (!q) {
    res.status(400).json({ error: "Missing q parameter" });
    return;
  }

  const apiKey = process.env.GOLFCOURSEAPI_KEY;
  if (!apiKey) {
    res.status(501).json({ error: "GOLFCOURSEAPI_KEY is not configured on the server — add it in Vercel project settings (Environment Variables) and redeploy." });
    return;
  }

  const url = `https://api.golfcourseapi.com/v1/search?search_query=${encodeURIComponent(q)}`;

  try {
    const upstream = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!upstream.ok) {
      // 401 here means the configured key itself is bad/revoked, not a client mistake —
      // surfaced as-is (not masked as a generic 502) so that specific case is easy to diagnose
      res.status(upstream.status).json({ error: `GolfCourseAPI responded ${upstream.status}` });
      return;
    }

    const data = await upstream.json();
    // course rating/slope data changes rarely (courses get re-rated at most every few years) —
    // cache hard at the edge, same reasoning as elevation.js, to stay well under the free tier's
    // 50 requests/day quota on repeat lookups of the same course name.
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: e && e.message ? e.message : "GolfCourseAPI request failed" });
  }
}
