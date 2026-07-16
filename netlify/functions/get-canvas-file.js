// netlify/functions/get-canvas-file.js
//
// Downloads a Canvas file's raw bytes (e.g. a .docx) and returns them as
// base64, so the browser can decode them and run the existing client-side
// docx checker on them — same checking logic as an uploaded file, just a
// different way of getting the bytes.
//
// REQUIRED Netlify environment variables: CANVAS_DOMAIN, CANVAS_API_TOKEN
//
// Query params:
//   fileId (required) — a Canvas file/attachment ID (from list-canvas-course-files.js)

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
  const fileId = (params.fileId || '').trim();

  if (!fileId || !/^\d+$/.test(fileId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing or invalid fileId.' }) };
  }

  try {
    // Step 1: get file metadata, which includes a download URL.
    const metaResp = await fetch(`https://${canvasDomain}/api/v1/files/${fileId}`, {
      headers: { Authorization: `Bearer ${canvasToken}` },
    });

    if (metaResp.status === 401) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Canvas rejected the API token (401 Unauthorized).' }) };
    }
    if (metaResp.status === 404) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Canvas couldn't find a file with that ID." }) };
    }
    if (!metaResp.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Canvas returned an unexpected error looking up the file (HTTP ${metaResp.status}).` }) };
    }

    const meta = await metaResp.json();
    const downloadUrl = meta.url;
    const displayName = meta.display_name || meta.filename || 'document.docx';

    if (!downloadUrl) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "Canvas didn't provide a download link for this file." }) };
    }

    // Step 2: download the actual file bytes. Canvas's file "url" is
    // typically a pre-signed link that doesn't need the Bearer token, but
    // sending it along is harmless if it's not needed.
    const fileResp = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${canvasToken}` } });
    if (!fileResp.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Couldn't download the file itself (HTTP ${fileResp.status}).` }) };
    }

    const arrayBuffer = await fileResp.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    // Netlify Functions have a response size limit (~6MB for synchronous
    // functions); base64 inflates size by ~33%, so warn rather than
    // silently fail on very large files.
    if (base64.length > 5_500_000) {
      return {
        statusCode: 413, headers,
        body: JSON.stringify({ error: `"${displayName}" is too large to fetch this way (over the size limit for this feature). Download it from Canvas and use the Word Docs tab's upload option instead.` }),
      };
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ displayName, base64 }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Unexpected error fetching the file: ' + err.message }) };
  }
};
