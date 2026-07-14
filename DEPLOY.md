# Deploying the function-enabled version

This version adds a **"Fetch transcript" from a link** option, which
requires a real serverless function running on Netlify's infrastructure —
not just static files. That changes how you deploy compared to the plain
version.

## Why you can't just drag-and-drop this one

**app.netlify.com/drop** only deploys static files — it doesn't run the
`netlify/functions/get-transcript.js` function. You need one of:

### Option A — Netlify CLI (fastest, no GitHub needed)

```bash
npm install -g netlify-cli
cd netlify-project
netlify login
netlify deploy --prod
```

When prompted, confirm the publish directory is `webapp` and it'll pick up
`netlify/functions` automatically from `netlify.toml`. This is the
quickest path if you just want it live today.

### Option B — Connect a GitHub repo (better for ongoing updates)

1. Push this `netlify-project` folder to a GitHub repo
2. In Netlify: **Add new site > Import an existing project** > connect
   the repo
3. Netlify reads `netlify.toml` automatically — publish directory
   `webapp`, functions directory `netlify/functions` — no manual config
   needed
4. Every future `git push` auto-deploys, including function updates

This is the better long-term option if you (or IT) will keep tweaking the
tool — no manual CLI redeploys needed.

## Testing locally before deploying

```bash
cd netlify-project
npm install -g netlify-cli   # if you don't have it yet
netlify dev
```

This runs both the static site AND the function locally (usually at
`http://localhost:8888`), so you can test the "Fetch transcript" button
before it's live.

## What changed from the plain static version

- Added a **link input + "Fetch transcript" button** at the top of the
  YouTube Transcript tab, above the existing paste-transcript option
- Added `netlify/functions/get-transcript.js` — fetches the real caption
  track server-side (works around a browser CORS restriction that blocks
  this from client-side JS) and returns it as VTT with **real** cue
  timing (start + duration from YouTube itself), which is more accurate
  than the paste method's estimated timing
- Added `netlify.toml` to tell Netlify where the site files and function
  live

## Honest limitations — please read

- **This uses an undocumented YouTube endpoint** (`video.google.com/timedtext`),
  the same one long-standing libraries like `youtube-transcript` and
  `youtube-transcript-api` rely on. It is not an official, stable public
  API. YouTube can change or block it without notice. I validated the
  parsing logic thoroughly against known response formats, but I could not
  test-call the live endpoint from this environment (YouTube isn't
  reachable from my sandbox) — please do a real test against a few actual
  videos once deployed, and treat this as "usually works, not guaranteed."
- **This changes the app's privacy story.** The plain static version's
  "nothing ever leaves your browser" claim no longer fully applies to this
  tab — a pasted link is sent to Netlify's servers to do the fetch. The
  paste-transcript method and the other three checkers (captions, HTML,
  docx) are unaffected and still fully client-side.
- **If it fails for a specific video** — private/unlisted videos, captions
  disabled, or YouTube rate-limiting Netlify's IP — the error message
  points the person to the paste method or `yt-dlp` as a fallback. Neither
  of those depend on this endpoint.
- **Rate limits:** Netlify's free tier includes a function invocation
  limit (check your plan at netlify.com/pricing if this gets heavy
  classroom use).
