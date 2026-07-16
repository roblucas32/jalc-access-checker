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

## Setting up Canvas Studio import (recommended — do this)

This is the reliable transcript source in the app, unlike the YouTube
function. It needs two environment variables set in Netlify (never in the
code, never committed to GitHub):

1. On Netlify: your site → **Site configuration → Environment variables**
2. Add:
   - `CANVAS_DOMAIN` — your Canvas domain, e.g. `johnalogancollege.beta.instructure.com` (no `https://`, no trailing slash)
   - `CANVAS_API_TOKEN` — a Canvas API token (see below)
3. Redeploy (environment variable changes need a fresh deploy to take effect — trigger one from the Deploys tab, or push any small commit)

**Getting the token:** Canvas → Account → Settings → Approved Integrations →
"+ New Access Token". For real (non-beta) use, ask your Canvas admin about
issuing a scoped **Developer Key** instead of a personal token — it limits
the blast radius to just what this tool needs (reading captions) rather
than everything your account can do.

**Finding a media ID:** the app's Canvas Studio field wants something like
`m-2rx2BapVQcm9RspcXwTL8mn148ixCGjz`. You can get this by calling
`GET /api/v1/courses/<course_id>/media_objects` with your token (see the
`media_id` field in the response) — a future version of this tool could
surface a course browser instead of requiring you to look this up
manually.

**Rotating the token:** tokens can expire or get revoked. If Canvas Studio
fetches start failing with an auth error, generate a fresh token in Canvas
and update the `CANVAS_API_TOKEN` environment variable in Netlify, then
redeploy.

## What changed from the plain static version

**Every content type now has two ways in: upload a file, or pull it
directly from a Canvas course.** All three use the same `CANVAS_DOMAIN` /
`CANVAS_API_TOKEN` environment variables — no separate setup per feature.

- **Captions tab:** paste a course, list its videos, click one to check —
  via `list-canvas-course-videos.js` + `get-canvas-transcript.js`
- **Web Pages tab:** paste a course, list its pages, click one to check —
  via `list-canvas-course-pages.js` + `get-canvas-page.js`. The fetched
  page body (a content fragment, not a full HTML document) is wrapped in a
  minimal shell with the page's own title before checking, so the
  document-level title/language checks — which don't make sense for a
  page fragment — don't false-positive.
- **Word Docs tab:** paste a course, list its `.docx` files, click one to
  check — via `list-canvas-course-files.js` + `get-canvas-file.js`. The
  file function downloads the raw bytes and returns them as base64; the
  browser decodes them and runs the exact same client-side docx checker
  used for uploads — no duplicate checking logic to maintain.

- Added a **Canvas Studio media ID input + "Fetch from Canvas Studio"
  button** on the import tab
- Added `netlify/functions/get-canvas-transcript.js` — calls Canvas's
  official, documented REST API server-side (so the API token stays
  private, never exposed to the browser) and returns the caption content
  Canvas Studio already has, as-is, with real cue timing
- Added `netlify.toml` to tell Netlify where the site files and function
  live
- A YouTube-based import (link fetch + paste-transcript converter) was
  built and then removed from this project after testing showed YouTube
  reliably blocks server-side requests like this one. Canvas Studio is the
  only external-fetch source now. To check a caption file you already have
  on hand — from YouTube, `yt-dlp`, or anywhere else — use the **Captions**
  tab, which accepts any `.vtt`/`.srt` file directly and runs entirely
  client-side.

## Honest limitations — please read

- **This changes the app's privacy story for one tab.** The Captions, Web
  Pages, and Word Docs tabs are fully client-side — nothing ever leaves
  the browser. The Canvas Studio tab is different: a media ID you enter is
  sent to Netlify's server, which calls Canvas's API using a private token
  and returns the caption content. Worth being upfront about with anyone
  using this.
- **The Canvas API token is a real secret.** It lives only as a Netlify
  environment variable, never in the code or GitHub repo. Treat it like
  any other credential — rotate it if it's ever been pasted into a
  terminal, chat, or log you're not fully sure is private.
- **Rate limits:** Netlify's free tier includes a function invocation
  limit (check your plan at netlify.com/pricing if this gets heavy
  classroom use). Canvas's API also has its own rate limits per token.

