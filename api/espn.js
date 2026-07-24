// /api/espn — ESPN fantasy API proxy (Chunk 0, blueprint §3.5)
//
// Reason for existence: the ESPN fantasy API sends no permissive CORS headers
// (constraint C1), so the browser cannot call it directly. All ESPN traffic is
// funnelled through this same-origin serverless function. It is stateless: it
// never persists cookies, never logs their values, and does no caching.
//
// Contract (POST JSON body):
//   { path: "/seasons/2026/segments/0/leagues/123456?view=mDraftDetail",
//     espn_s2: "...",            // optional (public leagues / players_wl)
//     swid:    "{...}",          // optional
//     fantasyFilter: { ... } }   // optional -> X-Fantasy-Filter header
//
// Behavior:
//   - Allow only whitelisted paths (no open proxy).
//   - GET ESPN_BASE_HOST + "/apis/v3/games/ffl" + path, forwarding cookies /
//     Accept / User-Agent / X-Fantasy-Filter as appropriate.
//   - Return upstream status + body verbatim.
//   - Upstream 401/403 -> { error: "auth" }.
//   - 10s upstream timeout.

// Single host constant (C5): if ESPN moves the host again this is the one-line fix.
const ESPN_BASE_HOST = 'https://lm-api-reads.fantasy.espn.com';
const API_PREFIX = '/apis/v3/games/ffl';

// Whitelist:
//   ""  or "/"                      -> game metadata (currentSeasonId derivation)
//   /seasons/<year>/segments/0/leagues/<id>...   -> league views
//   /seasons/<year>/players...                   -> player universe (players_wl)
const LEAGUE_OR_PLAYERS = /^\/seasons\/\d{4}\/(segments\/0\/leagues\/\d+|players)\b/;

function pathAllowed(path) {
  if (path === '' || path === '/') return true; // /apis/v3/games/ffl meta
  return LEAGUE_OR_PLAYERS.test(path);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'bad_json' }); }
  }
  body = body || {};

  const path = typeof body.path === 'string' ? body.path : '';
  const { espn_s2, swid, fantasyFilter } = body;

  if (!pathAllowed(path)) {
    return res.status(400).json({ error: 'path_not_allowed' });
  }

  const url = ESPN_BASE_HOST + API_PREFIX + path;

  const headers = {
    Accept: 'application/json',
    // Browser-like UA: ESPN blocks obviously scripted clients.
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  };

  // Cookies only when both are provided (private leagues, C2). Never logged.
  if (espn_s2 && swid) {
    headers.Cookie = `espn_s2=${espn_s2}; SWID=${swid}`;
  }

  if (fantasyFilter) {
    headers['X-Fantasy-Filter'] =
      typeof fantasyFilter === 'string' ? fantasyFilter : JSON.stringify(fantasyFilter);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  let upstream;
  try {
    upstream = await fetch(url, { method: 'GET', headers, signal: controller.signal });
  } catch (err) {
    clearTimeout(timeout);
    const aborted = err && err.name === 'AbortError';
    return res.status(504).json({ error: aborted ? 'upstream_timeout' : 'upstream_unreachable' });
  }
  clearTimeout(timeout);

  if (upstream.status === 401 || upstream.status === 403) {
    return res.status(upstream.status).json({ error: 'auth' });
  }

  const text = await upstream.text();
  res.status(upstream.status);
  const ct = upstream.headers.get('content-type');
  if (ct) res.setHeader('Content-Type', ct);
  // No caching (C5 / stateless proxy).
  res.setHeader('Cache-Control', 'no-store');
  return res.send(text);
}
