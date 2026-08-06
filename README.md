# Linksman — Golf Scorer

A standalone golf scoring app: handicap tracking, four-ball stroke play, better-ball teams,
drive/tee shot-shape stats, a personal course library with OpenStreetMap search, and —
for holes OpenStreetMap has mapped in detail — live GPS distance-to-green and drive-distance
tracking on a map.

## Run it locally

You'll need [Node.js](https://nodejs.org) installed (18+ recommended).

```bash
cd linksman
npm install
npm run dev
```

Then open the URL it prints (usually `http://localhost:5173`) in your browser.

Your courses, players, rounds and settings are saved in the browser's `localStorage` —
they persist between visits on the same browser/device, but won't sync across devices
unless you deploy it (see below) and always use the same browser to reach it.

> **Note on OpenStreetMap search locally:** `npm run dev` (plain Vite) does **not** serve the
> `/api/*` serverless functions that course search relies on (see below) — you'll see search
> requests fail with a 404 in this mode. Manual lat/lon course entry and everything else in the
> app work fine under `npm run dev`. To test OpenStreetMap search locally too, install the
> [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`) and run `vercel dev` instead —
> it serves the app *and* the `/api` functions together, matching production.

## Deploy it for free

### Vercel (recommended — required for OpenStreetMap course search)
1. Push this folder to a GitHub repo
2. Import the repo at [vercel.com/new](https://vercel.com/new)
3. Framework preset: **Vite** (auto-detected) — no config needed. The `api/` folder is
   auto-detected too and deployed as serverless functions; nothing extra to set up.
4. Deploy. You'll get a `*.vercel.app` URL immediately, with a custom domain option.
5. Connect the GitHub repo (step 1) once and every `git push` auto-redeploys from then on.

### Netlify
Netlify Drop (drag-and-drop a `dist/` folder) is a static-only host — it can't run the
`api/` serverless functions this app now depends on for OpenStreetMap search, so course
search would fail there. If you'd rather use Netlify than Vercel, connect it to the GitHub
repo and add the two files under `api/` as [Netlify Functions](https://docs.netlify.com/functions/overview/)
instead (they'd need minor adjustment to Netlify's handler signature). Vercel needs no such
changes, which is why it's the recommended path.

Either way, add the deployed site to your phone's home screen afterward (share menu →
"Add to Home Screen") for an app-like icon and full-screen feel.

## Course data: OpenStreetMap

The Courses tab can search OpenStreetMap directly (Nominatim for location, Overpass for
hole-by-hole geometry) — free, no API key. Coverage depends on whether volunteers have
mapped that specific course in detail:

- **Well-mapped courses** — you'll get real par, stroke index, and yardage per hole,
  computed from the mapped hole centerlines.
- **Partially-mapped courses** — you'll at least get the correct location pin; you fill
  in the scorecard by hand.
- **Unmapped courses** — falls back to the Google Maps search link + manual lat/lon entry
  that was already built in.

Because this relies on public OpenStreetMap data, be considerate with request volume —
it's shared free infrastructure, fine for personal use as-is.

**Server-side proxy (added 6 Aug):** the browser never talks to Nominatim/Overpass directly.
Both calls go through this app's own `/api/osm-search` and `/api/osm-holes` serverless
functions (in the `api/` folder), which forward the request server-side with a real,
identifying `User-Agent` header. This exists because a browser's JS `fetch()` can never set
a custom `User-Agent` at all (a hard browser restriction), and unidentified requests from a
generic `*.vercel.app`/`*.netlify.app` domain were found to get silently blocked by these
services' anti-abuse systems (confirmed via a `406` response in the browser's Network tab)
even though the exact same course worked instantly on `localhost` every time. The Overpass
mirror fallback (tries a couple of alternate public instances before giving up) also now
lives server-side in `api/osm-holes.js`, with a **↻ Retry hole lookup** button in the UI for
when every mirror is genuinely down.

Every hole-data result that's fetched successfully — including a genuine "nothing mapped"
answer — is cached in `localStorage`, keyed to that course's OpenStreetMap id. Re-selecting
the same course in a later search (any time, even after closing the browser or reinstalling
to the home screen — it's the same site's storage) loads instantly with **no network call
at all**, and shows a "🗄 cached" tag in the search results and a note on when it was last
checked. A **↻ Refresh from OpenStreetMap** button on a cached result forces a live re-check,
useful if you want to see if volunteers have added hole data since it was cached, or if a
now-stale cached failure needs clearing.

## Live distance-to-green & drive tracking

When a course is imported from OpenStreetMap and a hole has both a mapped tee and green,
the app stores their coordinates. During scoring (both individual stroke play and better
ball), that unlocks two things:

- **Live distance to green** — using your phone's GPS, a small "📍 _n_ to green (live)"
  readout appears under that hole's yardage, updating as you move.
- **Mark drive** — a "📍 Mark drive" button under each player's tee shot opens a map;
  tap where the ball landed and it calculates the drive distance from the tee (and the
  distance remaining to the green) using the actual mapped coordinates, not the straight
  hole yardage. Saved drives show up in that hole's cell and later in the round's History
  detail.

Holes without OSM tee/green data (manually entered courses, or partially-mapped ones —
shown with a "—" instead of "📍" in the GPS column when adding a course) simply don't show
these controls; there's no way to compute them without real coordinates.

One honest limitation: consumer phone GPS is typically accurate to a few meters at best,
so treat the live distance and drive-distance numbers as a close estimate, not a laser
rangefinder-grade measurement — same as most golf GPS apps.

## Golf bag, club suggestions & voice caddy

Each player has a **Golf bag** section in the Players tab (expand their card): tick which
clubs they carry from a standard list (Driver through Putter) and enter each club's usual
carry distance. A small 🎒 appears next to a player's name once they have at least one
club saved. None of this is required to score a round — it only powers the suggestion
features below.

Tap the ☆ next to a player's name to mark them ⭐ **as you** — this is a device-local
preference (stored in this browser only), not a login. It decides whose bag is used for
suggestions and where voice-logged clubs get saved.

With a player marked as you and a bag filled in, on holes with GPS data (see above) the
app suggests the club whose carry distance is closest to the live distance remaining —
shown as "🎒 7 Iron" wherever the live distance-to-green appears, in both individual
stroke play and better ball.

Each player also gets a small **Club** selector per hole to note which club they hit —
purely informational, saved with that round's history, and it never changes anyone's
saved bag distances. You can set it by hand, or use voice:

- Tap **🎙️ Voice caddy** during scoring (Chrome recommended — it needs the browser's
  built-in speech recognition, which isn't available everywhere; the button disables
  itself if your browser can't do it, and it needs microphone permission and HTTPS or
  localhost to work at all).
- Say something containing "Gaddy" (or "caddy"/"caddie" — recognizers hear it various
  ways) plus a club name, e.g. **"Hey Gaddy, I'm using a 6 iron."**
- It logs that club against whichever hole your GPS position is currently closest to,
  for whichever player is marked ⭐ you, speaks a short confirmation back, and — again —
  never touches your saved bag data.

This is genuinely a browser feature (the Web Speech API), not a cloud service Linksman
talks to, so there's no extra account or key needed — but recognition quality depends
entirely on your browser and device.

## Notes on the data model

- Distances are always stored internally in **yards**; the Yards/Meters toggle only
  changes display and entry, so switching units never double-converts anything.
- Handicap Index is a simplified approximation of the World Handicap System (best
  differentials out of the last 20 rounds, averaged × 0.96) — not an official GHIN number.
- Better-ball rounds are saved to history but intentionally don't feed individual
  handicap calculations, since a team score isn't a valid personal stroke-play differential.
