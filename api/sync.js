// /api/sync — share-code sync of custom rankings/weights/aliases (Chunk 6).
//
// Carryover from the Sleeper build: a short share code lets a user pull their
// custom rankings, blend weights, source renames and alias-map additions onto
// another device. Backed by Upstash Redis (REST). Cookies (espn_s2/SWID) are
// NEVER included in sync payloads — the client strips them before saving.
//
// Contract (POST JSON):
//   { action: "save", data: {...} }   -> { code: "ABC123" }
//   { action: "load", code: "ABC123" } -> { data: {...} }
//
// If Upstash env vars are absent the endpoint reports {error:"sync_unconfigured"}
// and the client falls back to localStorage-only (offline) behavior.

const URL_BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL_SECONDS = 60 * 60 * 24 * 120; // 120 days
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I/L

function makeCode(n = 6) {
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
  return s;
}

async function redis(command) {
  // Upstash REST: POST array-command form.
  const r = await fetch(URL_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return r.json(); // { result: ... }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!URL_BASE || !TOKEN) {
    return res.status(200).json({ error: 'sync_unconfigured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'bad_json' }); }
  }
  body = body || {};

  try {
    if (body.action === 'save') {
      if (!body.data || typeof body.data !== 'object') {
        return res.status(400).json({ error: 'bad_data' });
      }
      const payload = JSON.stringify(body.data);
      if (payload.length > 1_500_000) return res.status(413).json({ error: 'too_large' });
      const code = makeCode();
      await redis(['SET', 'share:' + code, payload, 'EX', String(TTL_SECONDS)]);
      return res.status(200).json({ code });
    }

    if (body.action === 'load') {
      const code = String(body.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4,10}$/.test(code)) return res.status(400).json({ error: 'bad_code' });
      const out = await redis(['GET', 'share:' + code]);
      if (!out || out.result == null) return res.status(404).json({ error: 'not_found' });
      let data = null;
      try { data = JSON.parse(out.result); } catch { return res.status(500).json({ error: 'corrupt' }); }
      return res.status(200).json({ data });
    }

    return res.status(400).json({ error: 'bad_action' });
  } catch (err) {
    return res.status(502).json({ error: 'sync_backend', detail: String(err.message || err) });
  }
}
