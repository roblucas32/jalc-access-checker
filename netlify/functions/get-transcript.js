// netlify/functions/get-transcript.js
//
// Fetches a YouTube video's caption track server-side (avoiding the browser
// CORS restriction that blocks this from client-side JS) and returns it as
// a ready-to-use VTT transcript.
//
// IMPORTANT — please read before relying on this in production:
// This works by fetching the video's normal watch page and reading the
// caption track list out of YouTube's embedded player data
// (ytInitialPlayerResponse), the same general approach used by tools like
// yt-dlp. It is NOT a documented, stable public API — there is no official
// one. YouTube can change its page structure or rate-limit server IPs
// (including Netlify's) without notice. If it starts failing across the
// board, fall back to the yt-dlp command-line method or the paste-transcript
// converter in this same app — both are more resilient than any
// browser-callable approach can be.
//
// Query params:
//   url  (required) — a YouTube video URL or bare 11-char video ID
//   lang (optional) — preferred language code, default "en"

const WATCH_URL = (videoId) => `https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US`;

// A normal desktop browser User-Agent + a CONSENT cookie value that's
// commonly needed to avoid YouTube's EU/region consent interstitial page,
// which otherwise replaces the real page content (including caption data)
// with a cookie-consent form.
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+119',
};

function extractVideoId(input) {
  const trimmed = (input || '').trim();
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

/**
 * Extracts a JSON array (or object) that follows `"key":` inside a larger
 * blob of text, using a string-aware bracket scanner so brackets that
 * appear inside quoted strings (e.g. a caption track name containing "[CC]")
 * don't throw off the boundary detection. Returns the raw JSON substring,
 * or null if the key isn't found or the brackets never balance.
 */
function extractJsonValue(text, key) {
  const marker = `"${key}":`;
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  let i = idx + marker.length;
  while (text[i] === ' ') i++;
  const openChar = text[i];
  if (openChar !== '[' && openChar !== '{') return null;
  const closeChar = openChar === '[' ? ']' : '}';

  let depth = 0;
  let inString = false;
  let escaped = false;
  const start = i;

  for (; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null; // brackets never balanced — malformed/truncated input
}

async function getCaptionTracks(videoId) {
  const resp = await fetch(WATCH_URL(videoId), { headers: FETCH_HEADERS });
  console.log(`[get-transcript] watch page fetch: status=${resp.status} videoId=${videoId}`);
  if (!resp.ok) {
    throw new HandledError(502, `YouTube returned an error loading the video page (HTTP ${resp.status}).`);
  }
  const html = await resp.text();
  console.log(`[get-transcript] watch page length: ${html.length} chars`);
  console.log(`[get-transcript] contains "captionTracks": ${html.includes('captionTracks')}`);
  console.log(`[get-transcript] contains "consent": ${html.toLowerCase().includes('consent')}`);
  console.log(`[get-transcript] contains "unusual traffic" or "captcha": ${/unusual traffic|captcha|recaptcha/i.test(html)}`);
  console.log(`[get-transcript] page title tag: ${(html.match(/<title>([^<]*)<\/title>/) || [])[1] || 'NOT FOUND'}`);
  console.log(`[get-transcript] first 300 chars: ${html.slice(0, 300).replace(/\s+/g, ' ')}`);

  const tracksJson = extractJsonValue(html, 'captionTracks');
  if (!tracksJson) {
    // Could genuinely have no captions, OR YouTube served a consent/bot-check
    // page instead of the real one. Both look the same from here.
    throw new HandledError(404, 'No captions found for this video (or YouTube blocked this request). Double-check captions are actually enabled on the video, or try yt-dlp locally to confirm.');
  }

  let tracks;
  try {
    tracks = JSON.parse(tracksJson);
  } catch (e) {
    throw new HandledError(502, "Found caption data on the page but couldn't parse it — YouTube may have changed its page format.");
  }

  return tracks.map(t => ({
    baseUrl: t.baseUrl,
    lang_code: t.languageCode,
    kind: t.kind, // "asr" for auto-generated, undefined for manual
    name: t.name && t.name.simpleText ? t.name.simpleText : '',
    isDefault: !!t.isDefault,
  }));
}

function pickBestTrack(tracks, preferredLang) {
  if (!tracks.length) return null;
  let match = tracks.find(t => t.lang_code === preferredLang && t.kind !== 'asr');
  if (match) return match;
  match = tracks.find(t => t.lang_code === preferredLang);
  if (match) return match;
  match = tracks.find(t => t.isDefault);
  if (match) return match;
  return tracks[0];
}

function parseTranscriptXml(xml) {
  const cues = [];
  const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  const attrRe = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = textRe.exec(xml))) {
    const attrs = {};
    let am;
    attrRe.lastIndex = 0;
    while ((am = attrRe.exec(m[1]))) attrs[am[1]] = decodeXmlEntities(am[2]);
    const start = parseFloat(attrs.start || '0');
    const dur = parseFloat(attrs.dur || '2');
    let text = decodeXmlEntities(m[2]);
    text = text.replace(/<[^>]+>/g, '').trim();
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
    lines.push(String(i + 1));
    lines.push(`${secondsToVttTs(cue.start)} --> ${secondsToVttTs(cue.start + cue.dur)}`);
    lines.push(cue.text);
    lines.push('');
  });
  return lines.join('\n');
}

class HandledError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
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
    const tracks = await getCaptionTracks(videoId);
    const track = pickBestTrack(tracks, preferredLang);
    if (!track || !track.baseUrl) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No usable caption track was found for this video.' }) };
    }

    const trackResp = await fetch(track.baseUrl, { headers: FETCH_HEADERS });
    if (!trackResp.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: `YouTube returned an error fetching the caption track (HTTP ${trackResp.status}).` }) };
    }
    const trackXml = await trackResp.text();
    const cues = parseTranscriptXml(trackXml);

    if (!cues.length) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Found a caption track but it came back empty.' }) };
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
    if (err instanceof HandledError) {
      return { statusCode: err.statusCode, headers, body: JSON.stringify({ error: err.message }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Unexpected error fetching the transcript: ' + err.message }) };
  }
};

module.exports.__testables = {
  extractVideoId, extractJsonValue, parseTranscriptXml, cuesToVtt, pickBestTrack, decodeXmlEntities, getCaptionTracks, HandledError,
};
