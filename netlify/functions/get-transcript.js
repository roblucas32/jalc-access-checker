// netlify/functions/get-transcript.js
//
// Fetches a YouTube video's caption track server-side (avoiding the browser
// CORS restriction that blocks this from client-side JS) and returns it as
// a ready-to-use VTT transcript.
//
// IMPORTANT — please read before relying on this in production:
// This uses YouTube's unofficial/undocumented "timedtext" caption endpoint
// (the same approach used by widely-used libraries like youtube-transcript
// and youtube-transcript-api). It is NOT a documented, stable public API.
// YouTube can change or rate-limit it without notice. If it starts failing
// across the board, fall back to the yt-dlp command-line method or the
// paste-transcript converter in this same app — both are more resilient.
//
// Query params:
//   url  (required) — a YouTube video URL or bare 11-char video ID
//   lang (optional) — preferred language code, default "en"

const TIMEDTEXT_LIST_URL = (videoId) =>
  `https://video.google.com/timedtext?type=list&v=${videoId}`;

const TIMEDTEXT_TRACK_URL = (videoId, lang, kind, name) => {
  let url = `https://video.google.com/timedtext?lang=${encodeURIComponent(lang)}&v=${videoId}`;
  if (kind) url += `&kind=${encodeURIComponent(kind)}`;
  if (name) url += `&name=${encodeURIComponent(name)}`;
  return url;
};

function extractVideoId(input) {
  const trimmed = (input || '').trim();
  // Bare 11-char video ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /[?&]v=([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) return m[1];
  }
  return null;
}

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function parseAttrs(attrString) {
  const attrs = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(attrString))) {
    attrs[m[1]] = decodeXmlEntities(m[2]);
  }
  return attrs;
}

function parseTrackList(xml) {
  const tracks = [];
  const trackRe = /<track\b([^>]*)\/>/g;
  let m;
  while ((m = trackRe.exec(xml))) {
    tracks.push(parseAttrs(m[1]));
  }
  return tracks;
}

function parseTranscriptXml(xml) {
  const cues = [];
  const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = textRe.exec(xml))) {
    const attrs = parseAttrs(m[1]);
    const start = parseFloat(attrs.start || '0');
    const dur = parseFloat(attrs.dur || '2');
    let text = decodeXmlEntities(m[2]);
    text = text.replace(/<[^>]+>/g, ''); // strip inline formatting tags (e.g. <i>)
    text = text.trim();
    if (text) cues.push({ start, dur, text });
  }
  return cues;
}

function secondsToVttTs(total) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

function cuesToVtt(cues) {
  if (!cues.length) return 'WEBVTT\n\n';
  const lines = ['WEBVTT', ''];
  cues.forEach((cue, i) => {
    const start = cue.start;
    const end = cue.start + cue.dur;
    lines.push(String(i + 1));
    lines.push(`${secondsToVttTs(start)} --> ${secondsToVttTs(end)}`);
    lines.push(cue.text);
    lines.push('');
  });
  return lines.join('\n');
}

function pickBestTrack(tracks, preferredLang) {
  if (!tracks.length) return null;
  // Prefer an exact language match that is NOT auto-generated (kind="asr")
  let match = tracks.find(t => t.lang_code === preferredLang && t.kind !== 'asr');
  if (match) return match;
  // Fall back to an exact language match even if auto-generated
  match = tracks.find(t => t.lang_code === preferredLang);
  if (match) return match;
  // Fall back to the default track if marked
  match = tracks.find(t => t.lang_default === 'true');
  if (match) return match;
  // Last resort: first available track
  return tracks[0];
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

  const params = event.queryStringParameters || {};
  const rawUrl = params.url;
  const preferredLang = params.lang || 'en';

  if (!rawUrl) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing "url" query parameter.' }) };
  }

  const videoId = extractVideoId(rawUrl);
  if (!videoId) {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: "Couldn't find a YouTube video ID in that URL. Paste a normal youtube.com/watch?v=... or youtu.be/... link." }),
    };
  }

  try {
    const listResp = await fetch(TIMEDTEXT_LIST_URL(videoId));
    if (!listResp.ok) {
      return {
        statusCode: 502, headers,
        body: JSON.stringify({ error: `YouTube returned an error looking up caption tracks (HTTP ${listResp.status}).` }),
      };
    }
    const listXml = await listResp.text();
    const tracks = parseTrackList(listXml);

    if (!tracks.length) {
      return {
        statusCode: 404, headers,
        body: JSON.stringify({ error: 'This video has no captions available (or captions are disabled). Try yt-dlp locally to double-check, or a different video.' }),
      };
    }

    const track = pickBestTrack(tracks, preferredLang);
    const trackResp = await fetch(TIMEDTEXT_TRACK_URL(videoId, track.lang_code, track.kind, track.name));
    if (!trackResp.ok) {
      return {
        statusCode: 502, headers,
        body: JSON.stringify({ error: `YouTube returned an error fetching the caption track (HTTP ${trackResp.status}).` }),
      };
    }
    const trackXml = await trackResp.text();
    const cues = parseTranscriptXml(trackXml);

    if (!cues.length) {
      return {
        statusCode: 502, headers,
        body: JSON.stringify({ error: 'Found a caption track but it came back empty. The video may have very new or restricted captions.' }),
      };
    }

    const vtt = cuesToVtt(cues);
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        vtt,
        cueCount: cues.length,
        lang: track.lang_code,
        autoGenerated: track.kind === 'asr',
        videoId,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: 'Unexpected error fetching the transcript: ' + err.message }),
    };
  }
};

// Exported for local/unit testing only — Netlify only calls `handler`.
module.exports.__testables = {
  extractVideoId, parseTrackList, parseTranscriptXml, cuesToVtt, pickBestTrack, decodeXmlEntities,
};
