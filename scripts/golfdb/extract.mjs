// Extracts golf course data (course listing + per-hole par/tee/green/bunker/hazard geometry)
// from a Geofabrik-style .osm.pbf regional extract, entirely offline -- no Overpass, no live API
// calls at all. Run once (or whenever you want fresh data); output is a plain JSON file ready to
// import into the app's own database. See README-golfdb.md for usage.
import { readOsmPbf } from "./pbf-osm-reader.mjs";
import { haversineMeters, farthestVertexFrom, nearestVertexFrom, centroid, pointInPolygon, holeCompleteness, nearestHoleNumber } from "./geo.mjs";

const GOLF_WAY_VALUES = new Set(["hole", "tee", "green", "bunker", "water_hazard", "lateral_water_hazard", "fairway"]);
const GOLF_NODE_VALUES = new Set(["tee", "green", "bunker"]); // "hole" is never a node in practice

function isWanted(tags) {
  if (!tags) return false;
  if (tags.leisure === "golf_course") return true;
  if (tags.golf) return true;
  return false;
}

async function run(inputPath, outputPath) {
  console.log(`Pass 1/2: scanning ${inputPath} for golf-tagged nodes and ways...`);
  const taggedNodes = []; // {id, lat, lon, tags}
  const taggedWays = []; // {id, tags, refs}
  const neededNodeIds = new Set();
  let totalNodes = 0, totalWays = 0;
  const t0 = Date.now();

  await readOsmPbf(
    inputPath,
    (n) => {
      totalNodes++;
      if (isWanted(n.tags)) taggedNodes.push(n);
    },
    (w) => {
      totalWays++;
      if (isWanted(w.tags)) {
        taggedWays.push(w);
        for (const id of w.refs) neededNodeIds.add(id);
      }
    }
  );
  console.log(`  scanned ${totalNodes.toLocaleString()} nodes, ${totalWays.toLocaleString()} ways in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  found ${taggedNodes.length} tagged nodes, ${taggedWays.length} tagged ways; need coordinates for ${neededNodeIds.size.toLocaleString()} way-member nodes`);

  console.log(`Pass 2/2: resolving coordinates for those ${neededNodeIds.size.toLocaleString()} nodes...`);
  const t1 = Date.now();
  const nodeLocations = new Map();
  for (const n of taggedNodes) if (neededNodeIds.has(n.id)) nodeLocations.set(n.id, { lat: n.lat, lon: n.lon });
  await readOsmPbf(
    inputPath,
    (n) => {
      if (neededNodeIds.has(n.id) && !nodeLocations.has(n.id)) nodeLocations.set(n.id, { lat: n.lat, lon: n.lon });
    },
    () => {}
  );
  console.log(`  resolved ${nodeLocations.size.toLocaleString()} / ${neededNodeIds.size.toLocaleString()} needed node coordinates in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  if (nodeLocations.size < neededNodeIds.size) {
    console.warn(`  WARNING: ${neededNodeIds.size - nodeLocations.size} referenced nodes were never found -- some way geometry may be incomplete (normal if the extract's bbox clips a way at its edge).`);
  }

  // Resolve every tagged way's full vertex geometry now that we have the coordinates.
  for (const w of taggedWays) {
    w.geometry = w.refs.map((id) => nodeLocations.get(id)).filter(Boolean);
  }

  // --- Course anchors: leisure=golf_course ways (polygon, preferred) and nodes (point only) ---
  const courseAnchors = [];
  for (const w of taggedWays) {
    if (w.tags.leisure !== "golf_course") continue;
    if (w.geometry.length < 3) continue; // not a usable ring
    const c = centroid(w.geometry);
    courseAnchors.push({ id: `way/${w.id}`, name: w.tags.name || null, polygon: w.geometry, lat: c.lat, lon: c.lon });
  }
  for (const n of taggedNodes) {
    if (n.tags.leisure !== "golf_course") continue;
    courseAnchors.push({ id: `node/${n.id}`, name: n.tags.name || null, polygon: null, lat: n.lat, lon: n.lon });
  }
  console.log(`Found ${courseAnchors.length} golf_course anchors (${courseAnchors.filter((c) => c.polygon).length} with a mapped boundary, ${courseAnchors.filter((c) => !c.polygon).length} point-only)`);

  // --- Assign every golf=* element to the course anchor it belongs to ---
  const golfWayElements = taggedWays.filter((w) => w.tags.golf && GOLF_WAY_VALUES.has(w.tags.golf) && w.geometry.length > 0);
  const golfNodeElements = taggedNodes.filter((n) => n.tags.golf && GOLF_NODE_VALUES.has(n.tags.golf));

  function assignCourse(lat, lon) {
    // Prefer actual polygon containment when a course has a mapped boundary.
    for (const c of courseAnchors) {
      if (c.polygon && pointInPolygon(lat, lon, c.polygon)) return c;
    }
    // Fall back to nearest course anchor by centroid distance (covers point-only anchors, and
    // any element that falls just outside an imperfectly-closed boundary).
    let best = null, bestDist = Infinity;
    for (const c of courseAnchors) {
      const d = haversineMeters(lat, lon, c.lat, c.lon);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    // A sanity cap: don't assign an element to a course 5km+ away just because it's the
    // "closest" one in a sparsely-mapped area -- that's almost certainly not really part of it.
    return bestDist <= 5000 ? best : null;
  }

  const byCourse = new Map(); // anchor.id -> { anchor, holeWays: [], greenEls: [], bunkerEls: [], hazardEls: [], fairwayEls: [], teeEls: [] }
  function bucket(anchor) {
    if (!byCourse.has(anchor.id)) byCourse.set(anchor.id, { anchor, holeWays: [], greenEls: [], bunkerEls: [], hazardEls: [], fairwayEls: [], teeEls: [] });
    return byCourse.get(anchor.id);
  }
  for (const w of golfWayElements) {
    const c = centroid(w.geometry);
    const course = assignCourse(c.lat, c.lon);
    if (!course) continue;
    const b = bucket(course);
    if (w.tags.golf === "hole") b.holeWays.push(w);
    else if (w.tags.golf === "green") b.greenEls.push(w);
    else if (w.tags.golf === "bunker") b.bunkerEls.push(w);
    else if (w.tags.golf === "water_hazard" || w.tags.golf === "lateral_water_hazard") b.hazardEls.push(w);
    else if (w.tags.golf === "fairway") b.fairwayEls.push(w);
    else if (w.tags.golf === "tee") b.teeEls.push(w);
  }
  for (const n of golfNodeElements) {
    const course = assignCourse(n.lat, n.lon);
    if (!course) continue;
    const b = bucket(course);
    if (n.tags.golf === "tee") b.teeEls.push(n);
    else if (n.tags.golf === "green") b.greenEls.push({ tags: n.tags, geometry: [{ lat: n.lat, lon: n.lon }] });
    else if (n.tags.golf === "bunker") b.bunkerEls.push({ tags: n.tags, geometry: [{ lat: n.lat, lon: n.lon }] });
  }

  // --- Within each course, build holes and match green/bunker/hazard/tee elements to them ---
  // This section deliberately mirrors parseOSMHoleElements in src/App.jsx (hole building, green
  // polygon upgrade, "both"-anchor bunker/hazard matching) so an imported course behaves
  // identically to one fetched live. Tee-color detection (buildOSMTeeSets' richer per-color
  // tee-set logic) is intentionally NOT ported in this first pass -- real-world golf=tee
  // coverage is sparse enough (per the app's own existing comments) that it's a reasonable v1
  // scope cut; holes still carry a single teeLat/teeLon from the golf=hole way itself.
  const courses = [];
  for (const { anchor, holeWays, greenEls, bunkerEls, hazardEls, fairwayEls } of byCourse.values()) {
    if (holeWays.length === 0) continue; // a golf_course anchor with no mapped holes isn't useful to import

    const parsedByNumber = new Map();
    for (const w of holeWays) {
      const num = w.tags.ref ? Number(w.tags.ref) : null;
      if (num == null || Number.isNaN(num)) continue;
      let meters = 0;
      for (let i = 1; i < w.geometry.length; i++) meters += haversineMeters(w.geometry[i - 1].lat, w.geometry[i - 1].lon, w.geometry[i].lat, w.geometry[i].lon);
      const tee = w.geometry[0], green = w.geometry[w.geometry.length - 1];
      const h = {
        number: num,
        par: w.tags.par ? Number(w.tags.par) : null,
        strokeIndex: w.tags.handicap ? Number(w.tags.handicap) : null,
        yardageMeters: meters ? Math.round(meters) : null,
        teeLat: tee?.lat ?? null, teeLon: tee?.lon ?? null,
        greenLat: green?.lat ?? null, greenLon: green?.lon ?? null,
        greenPolygon: null, bunkers: null, hazards: null, fairways: null,
      };
      const existing = parsedByNumber.get(num);
      if (!existing || holeCompleteness(h) > holeCompleteness(existing)) parsedByNumber.set(num, h);
    }
    const holes = [...parsedByNumber.values()].sort((a, b) => a.number - b.number);
    if (!holes.length) continue;

    // green polygons
    const greenByHole = new Map();
    for (const el of greenEls) {
      const c = centroid(el.geometry);
      const num = el.tags?.ref ? Number(el.tags.ref) : nearestHoleNumber(c.lat, c.lon, holes, "green");
      if (num == null) continue;
      const existing = greenByHole.get(num);
      if (!existing || el.geometry.length > existing.length) greenByHole.set(num, el.geometry);
    }
    for (const h of holes) {
      const poly = greenByHole.get(h.number);
      if (!poly) continue;
      h.greenPolygon = poly;
      if (h.teeLat != null) {
        const back = farthestVertexFrom(h.teeLat, h.teeLon, poly);
        if (back) { h.greenLat = back.lat; h.greenLon = back.lon; }
      }
    }

    // bunkers / hazards / fairways (5 Nov) -- "both" anchor, same reasoning as the live endpoint
    function collect(elements) {
      const byHole = new Map();
      for (const el of elements) {
        const c = centroid(el.geometry);
        const num = nearestHoleNumber(c.lat, c.lon, holes, "both");
        if (num == null) continue;
        if (!byHole.has(num)) byHole.set(num, []);
        byHole.get(num).push(el.geometry);
      }
      return byHole;
    }
    const bunkersByHole = collect(bunkerEls);
    const hazardsByHole = collect(hazardEls);
    const fairwaysByHole = collect(fairwayEls);
    for (const h of holes) {
      h.bunkers = bunkersByHole.get(h.number) || null;
      h.hazards = (hazardsByHole.get(h.number) || []).length ? hazardsByHole.get(h.number).map((vertices) => ({ kind: "water_hazard", vertices })) : null;
      h.fairways = fairwaysByHole.get(h.number) || null;
    }

    courses.push({
      name: anchor.name || "Unnamed golf course",
      lat: anchor.lat, lon: anchor.lon,
      holeCount: holes.length,
      holes,
    });
  }

  console.log(`\nBuilt ${courses.length} importable course(s) (had holes mapped) out of ${courseAnchors.length} golf_course anchors found.`);
  const fs = await import("fs");
  fs.writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), courses }, null, 2));
  console.log(`Wrote ${outputPath}`);
  return courses;
}

const [, , inputPath, outputPath] = process.argv;
if (!inputPath) {
  console.error("Usage: node extract.mjs <input.osm.pbf> [output.json]");
  process.exit(1);
}
run(inputPath, outputPath || "golf-courses.json").catch((e) => { console.error(e); process.exit(1); });

export { run };
