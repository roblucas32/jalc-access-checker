// netlify/functions/list-canvas-course-videos.js
//
// Lists every video (Canvas "media object") in a course, so instructors can
// pick one by title instead of digging a media ID out of page source. Uses
// the same authenticated Canvas API as get-canvas-transcript.js.
//
// REQUIRED Netlify environment variables (same ones get-canvas-transcript.js
// uses):
//   CANVAS_DOMAIN
//   CANVAS_API_TOKEN
//
// Query params:
//   course (required) — a Canvas course ID, or a full course URL like
//                        https://yourschool.instructure.com/courses/265

function extractCourseId(input) {
  const trimmed = (input || '').trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/\/courses\/(\d+)/);
  return m ? m[1] : null;
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
  const courseId = extractCourseId(params.course);

  if (!courseId) {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: "Couldn't find a course ID in that. Paste the course URL (e.g. https://yourschool.instructure.com/courses/265) or just the number." }),
    };
  }

  // NOTE: this fetches only the first page of results (Canvas defaults to
  // 10 per page). Courses with a very large media library would need
  // pagination added here — fine for typical course sizes, worth revisiting
  // if a course has more videos than one page shows.
  const url = `https://${canvasDomain}/api/v1/courses/${encodeURIComponent(courseId)}/media_objects?per_page=100`;

  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${canvasToken}` },
    });

    if (resp.status === 401) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Canvas rejected the API token (401 Unauthorized). The token may be expired or revoked.' }) };
    }
    if (resp.status === 404) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Canvas couldn't find a course with that ID, or this account doesn't have access to it." }) };
    }
    if (!resp.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Canvas returned an unexpected error (HTTP ${resp.status}).` }) };
    }

    const mediaObjects = await resp.json();
    if (!Array.isArray(mediaObjects)) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "Canvas returned data in an unexpected format." }) };
    }

    const videos = mediaObjects.map(m => ({
      mediaId: m.media_id,
      title: m.title || '(untitled video)',
      hasCaptions: Array.isArray(m.media_tracks) && m.media_tracks.length > 0,
    }));

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ courseId, videos }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Unexpected error listing course videos: ' + err.message }) };
  }
};

module.exports.__testables = { extractCourseId };
