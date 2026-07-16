// netlify/functions/get-canvas-page.js
//
// Fetches one Canvas page's full HTML body via the official Canvas API, so
// it can be run through the same client-side HTML checker used for
// uploaded files.
//
// REQUIRED Netlify environment variables: CANVAS_DOMAIN, CANVAS_API_TOKEN
//
// Query params:
//   course (required) — a Canvas course ID or course URL
//   pageUrl (required) — the page's url slug (from list-canvas-course-pages.js)

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
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
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
  const pageUrl = (params.pageUrl || '').trim();

  if (!courseId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing or invalid course." }) };
  }
  if (!pageUrl) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing pageUrl." }) };
  }

  const url = `https://${canvasDomain}/api/v1/courses/${encodeURIComponent(courseId)}/pages/${encodeURIComponent(pageUrl)}`;

  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${canvasToken}` } });

    if (resp.status === 401) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Canvas rejected the API token (401 Unauthorized).' }) };
    }
    if (resp.status === 404) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Canvas couldn't find that page." }) };
    }
    if (!resp.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Canvas returned an unexpected error (HTTP ${resp.status}).` }) };
    }

    const page = await resp.json();
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ title: page.title || pageUrl, body: page.body || '' }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Unexpected error fetching the page: ' + err.message }) };
  }
};

module.exports.__testables = { extractCourseId };
