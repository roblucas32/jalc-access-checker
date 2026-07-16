// netlify/functions/list-canvas-course-files.js
//
// Lists .docx files in a course's Canvas Files, so instructors can pick one
// to check instead of downloading it manually first.
//
// REQUIRED Netlify environment variables: CANVAS_DOMAIN, CANVAS_API_TOKEN
//
// Query params:
//   course (required) — a Canvas course ID or course URL

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function extractCourseId(input) {
  const trimmed = (input || '').trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/\/courses\/(\d+)/);
  return m ? m[1] : null;
}

function isDocx(file) {
  const contentType = file['content-type'] || file.content_type || '';
  const name = file.display_name || file.filename || '';
  return contentType === DOCX_MIME || /\.docx$/i.test(name);
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

  if (!courseId) {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: "Couldn't find a course ID in that. Paste the course URL (e.g. https://yourschool.instructure.com/courses/265) or just the number." }),
    };
  }

  // NOTE: fetches only the first 100 files, unfiltered server-side (some
  // Canvas instances don't set content-type reliably on upload, so we
  // filter by both content-type AND filename extension after fetching,
  // rather than relying on Canvas's content_types[] query filter alone).
  // A course with more than 100 files total would need pagination added.
  const url = `https://${canvasDomain}/api/v1/courses/${encodeURIComponent(courseId)}/files?per_page=100`;

  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${canvasToken}` } });

    if (resp.status === 401) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Canvas rejected the API token (401 Unauthorized). The token may be expired or revoked.' }) };
    }
    if (resp.status === 404) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Canvas couldn't find a course with that ID, or this account doesn't have access to it." }) };
    }
    if (!resp.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Canvas returned an unexpected error (HTTP ${resp.status}).` }) };
    }

    const files = await resp.json();
    if (!Array.isArray(files)) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "Canvas returned data in an unexpected format." }) };
    }

    const docxFiles = files.filter(isDocx).map(f => ({
      id: f.id,
      displayName: f.display_name || f.filename || '(untitled file)',
      size: f.size || 0,
      // "hidden" is Canvas's flag for a file that's uploaded but not visible
      // to students (the file equivalent of an unpublished page). Locked
      // files (locked=true, or a future unlock_at date) are also not
      // currently accessible to students, so treat those as draft too.
      isDraft: !!f.hidden || !!f.locked || (!!f.unlock_at && new Date(f.unlock_at) > new Date()),
    }));

    return { statusCode: 200, headers, body: JSON.stringify({ courseId, files: docxFiles, totalFilesInCourse: files.length }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Unexpected error listing course files: ' + err.message }) };
  }
};

module.exports.__testables = { extractCourseId, isDocx, DOCX_MIME };
