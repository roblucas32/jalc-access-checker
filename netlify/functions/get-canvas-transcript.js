// netlify/functions/get-canvas-transcript.js
//
// Fetches a caption track directly from Canvas (Canvas Studio videos are
// Kaltura-backed Canvas "Media Objects") via the official, documented
// Canvas LMS REST API — a real authenticated call, not scraping. Much more
// reliable than the YouTube function in this same project.
//
// REQUIRED Netlify environment variables (set in Site settings > Environment
// variables — NEVER commit these to the repo):
//   CANVAS_DOMAIN     e.g. "johnalogancollege.beta.instructure.com"
//   CANVAS_API_TOKEN  a Canvas API token (ideally a scoped Developer Key
//                      token rather than a personal one — see DEPLOY.md)
//
// Query params:
//   mediaId (required) — the Canvas media object id, e.g. "m-2rx2BapVQcm..."
//                         (visible via the /media_objects list endpoint, or
//                         in the Studio embed URL)
//   locale  (optional) — preferred caption language code, default "en"

function sanitizeMediaId(raw) {
  const trimmed = (raw || '').trim();
  // Canvas media object IDs are alphanumeric plus dashes/underscores only.
  // Reject anything else so this can't be used to inject an arbitrary path
  // into the upstream request.
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

function pickBestTrack(tracks, preferredLocale) {
  if (!tracks.length) return null;
  let match = tracks.find(t => t.locale === preferredLocale && !t.asr);
  if (match) return match;
  match = tracks.find(t => t.locale === preferredLocale);
  if (match) return match;
  match = tracks.find(t => !t.asr);
  if (match) return match;
  return tracks[0];
}

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // Optional lightweight gate: if APP_SHARED_SECRET is set in Netlify's
  // environment variables, every request must include a matching
  // X-App-Secret header, or it's rejected before touching Canvas at all.
  // This is NOT a strong secret — index.html is public, so the value this
  // header carries is visible to anyone who inspects the page's source or
  // network traffic while using the app. What it DOES do: stops casual,
  // automated scanning of these function URLs by anyone who never actually
  // opens the app (the most likely real-world abuse pattern for an
  // unauthenticated endpoint sitting on the public internet). It does not
  // stop someone who deliberately inspects the app while using it. If left
  // unset, this check is skipped entirely (no behavior change).
  const appSecret = process.env.APP_SHARED_SECRET;
  if (appSecret) {
    const provided = event.headers['x-app-secret'] || event.headers['X-App-Secret'];
    if (provided !== appSecret) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }
  }

  const canvasDomain = process.env.CANVAS_DOMAIN;
  const canvasToken = process.env.CANVAS_API_TOKEN;

  if (!canvasDomain || !canvasToken) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: 'Server is not configured with CANVAS_DOMAIN / CANVAS_API_TOKEN environment variables yet.' }),
    };
  }

  const params = event.queryStringParameters || {};
  const mediaId = sanitizeMediaId(params.mediaId);
  const preferredLocale = params.locale || 'en';

  if (!mediaId) {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: 'Missing or invalid "mediaId" query parameter. It should look like "m-2rx2BapVQcm9RspcXwTL8mn148ixCGjz".' }),
    };
  }

  const url = `https://${canvasDomain}/api/v1/media_objects/${encodeURIComponent(mediaId)}/media_tracks?include[]=content`;

  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${canvasToken}` },
    });

    if (resp.status === 401) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Canvas rejected the API token (401 Unauthorized). The token may be expired or revoked — generate a new one and update the CANVAS_API_TOKEN environment variable.' }) };
    }
    if (resp.status === 404) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Canvas couldn't find a media object with that ID. Double-check the ID was copied correctly." }) };
    }
    if (!resp.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Canvas returned an unexpected error (HTTP ${resp.status}).` }) };
    }

    const tracks = await resp.json();
    if (!Array.isArray(tracks) || !tracks.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'This video has no caption tracks in Canvas Studio yet.' }) };
    }

    const track = pickBestTrack(tracks, preferredLocale);
    if (!track || !track.content) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Found a caption track but it has no content yet — it may still be processing in Canvas Studio." }) };
    }

    // Canvas Studio returns content already as WEBVTT text — no conversion needed.
    const vtt = track.content;
    const cueCount = (vtt.match(/-->/g) || []).length;

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        vtt,
        cueCount,
        locale: track.locale,
        autoGenerated: !!track.asr,
        workflowState: track.workflow_state,
        mediaId,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Unexpected error fetching the transcript: ' + err.message }) };
  }
};

module.exports.__testables = { sanitizeMediaId, pickBestTrack };
