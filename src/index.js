import Anthropic from '@anthropic-ai/sdk';

/* ================= helpers ================= */
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
const bad = (msg, status = 400) => json({ error: msg }, status);

// The device token is an anonymous per-browser id. It is not a login: it stops
// casual double voting and paces submissions, nothing stronger.
const voterOf = (req) => (req.headers.get('x-haunt-voter') || '').slice(0, 64);

// Constant-time-ish compare so the admin code can't be probed byte by byte.
function codeMatches(given, expected) {
  if (!expected || typeof given !== 'string' || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
const isAdmin = (req, env) => codeMatches(req.headers.get('x-haunt-admin') || '', env.ADMIN_CODE);

const rowToListing = (r) => ({
  id: r.id,
  lat: r.lat,
  lng: r.lng,
  nick: r.nick,
  ts: r.ts,
  hidden: !!r.hidden,
  review: !!r.review,
  demo: !!r.demo,
  trust: r.trust,
  cover: r.cover,
  photos: JSON.parse(r.photos || '[]'),
  email: r.email,
});

/* ================= photos =================
   Photos arrive as data URLs from the client's canvas. We keep the raw base64
   in KV (immutable once written, so eventual consistency is harmless) and
   serve it back as a real image with a long cache, instead of pushing base64
   through JSON on every read. */
const PHOTO_PREFIX = 'photo:';
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

// allowSvg is only ever set for admin-seeded demo art. An SVG uploaded by a
// visitor and served back from our own origin would run its own script when
// opened directly, so submissions are raster-only.
async function putPhoto(env, id, dataUrl, allowSvg = false) {
  const types = allowSvg ? /jpeg|png|webp|svg\+xml/ : /jpeg|png|webp/;
  const m = /^data:image\/([a-z+]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m || !types.test(m[1])) return null;
  const [, kind, b64] = m;
  if (b64.length * 0.75 > MAX_PHOTO_BYTES) return null;
  await env.PHOTOS.put(PHOTO_PREFIX + id, b64, { metadata: { type: `image/${kind}` } });
  return id;
}

async function getPhoto(env, id) {
  const { value, metadata } = await env.PHOTOS.getWithMetadata(PHOTO_PREFIX + id);
  if (!value) return new Response('Not found', { status: 404 });
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'content-type': (metadata && metadata.type) || 'image/jpeg',
      // Photo ids are unique per upload and never rewritten, so this is safe.
      'cache-control': 'public, max-age=31536000, immutable',
      // Belt and braces alongside the raster-only rule in putPhoto.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'x-content-type-options': 'nosniff',
    },
  });
}

/* ================= photo scan =================
   The browser must never hold an API key, so moderation runs here. */
const SCAN_PROMPT = `This photo was submitted to a neighborhood Halloween decoration contest. Judge only what is visible.

display: the main subject is a house, yard, porch or building with Halloween or autumn decorations.
outdoor: shot outdoors from the street or sidewalk.
safe: false for nudity, sexual content, real gore or injury, hate symbols, real weapons aimed at anyone, drug use, or slurs on signage. Ordinary Halloween props like fake skeletons, tombstones, fake blood and horror figures are safe.
people: how prominently real people appear.
children: any real child is visible.
identifying: a house number, street sign, name plate, license plate or personal document is legible.
screenshot: the image is a screenshot, a photo of a screen, a meme or stock art.
names: two playful nicknames for this display, three words max each, no address and no personal names.
reason: one short sentence, plain language, only if something is wrong.`;

const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    display: { type: 'boolean' },
    outdoor: { type: 'boolean' },
    safe: { type: 'boolean' },
    people: { type: 'string', enum: ['none', 'background', 'prominent'] },
    children: { type: 'boolean' },
    identifying: { type: 'boolean' },
    screenshot: { type: 'boolean' },
    names: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
  required: ['display', 'outdoor', 'safe', 'people', 'children', 'identifying', 'screenshot', 'names', 'reason'],
  additionalProperties: false,
};

async function scanPhoto(req, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, reason: 'scan_unconfigured' });
  const body = await req.json().catch(() => null);
  const data = body && typeof body.image === 'string' ? body.image.split(',').pop() : null;
  if (!data) return bad('image required');
  if (data.length * 0.75 > MAX_PHOTO_BYTES) return bad('image too large');

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  try {
    const msg = await client.beta.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4096,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCAN_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
            { type: 'text', text: SCAN_PROMPT },
          ],
        },
      ],
    });

    // A refusal means the model declined to describe the image at all. For a
    // neighborhood contest that is itself a reason not to publish it.
    if (msg.stop_reason === 'refusal') {
      return json({
        ok: true,
        verdict: {
          display: false, outdoor: false, safe: false, people: 'none',
          children: false, identifying: false, screenshot: false, names: [],
          reason: 'This one is not appropriate for a neighborhood contest.',
        },
      });
    }

    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return json({ ok: true, verdict: JSON.parse(text) });
  } catch (err) {
    // Callers treat this as "could not be checked" and flag for human review.
    console.error('scan failed', err);
    return json({ ok: false, reason: 'scan_failed' });
  }
}

/* ================= state ================= */
async function getState(env) {
  const [listings, tallies, settings] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM listings ORDER BY ts ASC'),
    env.DB.prepare('SELECT * FROM votes'),
    env.DB.prepare("SELECT value FROM settings WHERE key = 'cfg'"),
  ]);
  const votes = {};
  for (const v of tallies.results) votes[v.listing_id] = { r: v.remote, p: v.in_person };
  const cfgRow = settings.results[0];
  return json({
    cfg: cfgRow ? JSON.parse(cfgRow.value) : null,
    index: listings.results.map(rowToListing),
    votes,
  });
}

/* ================= voting ================= */
async function castVote(req, env) {
  const voter = voterOf(req);
  if (!voter) return bad('missing device token');
  const { id, kind } = (await req.json().catch(() => ({}))) || {};
  if (!id || (kind !== 'r' && kind !== 'p')) return bad('id and kind required');

  const listing = await env.DB.prepare('SELECT id, hidden FROM listings WHERE id = ?').bind(id).first();
  if (!listing || listing.hidden) return bad('no such listing', 404);

  const r = kind === 'r' ? 1 : 0;
  const p = kind === 'p' ? 1 : 0;
  try {
    // One transaction: the ballot insert is the guard, the tally is the effect.
    // If the ballot collides on (listing_id, voter) the whole batch rolls back.
    await env.DB.batch([
      env.DB.prepare('INSERT INTO ballots (listing_id, voter, kind, ts) VALUES (?, ?, ?, ?)')
        .bind(id, voter, kind, Date.now()),
      env.DB.prepare(
        `INSERT INTO votes (listing_id, remote, in_person) VALUES (?, ?, ?)
         ON CONFLICT(listing_id) DO UPDATE SET
           remote = remote + excluded.remote,
           in_person = in_person + excluded.in_person`
      ).bind(id, r, p),
    ]);
  } catch (err) {
    if (String(err).includes('UNIQUE') || String(err).includes('PRIMARY')) {
      return json({ error: 'already voted', already: true }, 409);
    }
    throw err;
  }

  const row = await env.DB.prepare('SELECT remote, in_person FROM votes WHERE listing_id = ?').bind(id).first();
  return json({ ok: true, tally: { r: row.remote, p: row.in_person } });
}

/* ================= submitting ================= */
const MAX_PER_DAY = 5;
const MAX_PHOTOS = 8;

async function submit(req, env) {
  const voter = voterOf(req);
  if (!voter) return bad('missing device token');
  const body = (await req.json().catch(() => null)) || {};
  const { lat, lng, nick, cover, photos, trust, review, email } = body;

  if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) {
    return bad('lat and lng required');
  }
  if (!Array.isArray(photos) || !photos.length) return bad('at least one photo required');

  const since = Date.now() - 864e5;
  const { c } = await env.DB.prepare('SELECT COUNT(*) AS c FROM submissions WHERE voter = ? AND ts > ?')
    .bind(voter, since).first();
  if (c >= MAX_PER_DAY) return json({ error: 'daily limit reached' }, 429);

  const id = crypto.randomUUID().slice(0, 12);
  const pids = [];
  for (const dataUrl of photos.slice(0, MAX_PHOTOS)) {
    const pid = await putPhoto(env, `${id}-${pids.length}`, dataUrl);
    if (pid) pids.push(pid);
  }
  if (!pids.length) return bad('no usable photos');
  const coverId = (await putPhoto(env, `${id}-cover`, cover)) || pids[0];

  const rec = {
    id,
    lat: +lat.toFixed(6),
    lng: +lng.toFixed(6),
    nick: String(nick || '').slice(0, 46),
    ts: Date.now(),
    hidden: 0,
    review: review ? 1 : 0,
    demo: 0,
    trust: String(trust || 'manual').slice(0, 16),
    cover: coverId,
    photos: JSON.stringify(pids),
    email: String(email || '').slice(0, 120),
    owner: voter,
  };

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO listings (id, lat, lng, nick, ts, hidden, review, demo, trust, cover, photos, email, owner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(rec.id, rec.lat, rec.lng, rec.nick, rec.ts, rec.hidden, rec.review, rec.demo,
           rec.trust, rec.cover, rec.photos, rec.email, rec.owner),
    env.DB.prepare('INSERT INTO submissions (voter, ts) VALUES (?, ?)').bind(voter, rec.ts),
  ]);

  return json({ ok: true, listing: rowToListing(rec) });
}

async function addPhotos(req, env) {
  const voter = voterOf(req);
  const body = (await req.json().catch(() => null)) || {};
  const { id, photos, review } = body;
  if (!id || !Array.isArray(photos) || !photos.length) return bad('id and photos required');

  const row = await env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first();
  if (!row) return bad('no such listing', 404);
  const existing = JSON.parse(row.photos || '[]');
  if (existing.length >= MAX_PHOTOS) return bad('that listing already has the maximum photos');

  const added = [];
  for (const dataUrl of photos.slice(0, MAX_PHOTOS - existing.length)) {
    const pid = await putPhoto(env, `${id}-${existing.length + added.length}-${Date.now()}`, dataUrl);
    if (pid) added.push(pid);
  }
  if (!added.length) return bad('no usable photos');

  const merged = existing.concat(added);
  await env.DB.prepare('UPDATE listings SET photos = ?, review = ? WHERE id = ?')
    .bind(JSON.stringify(merged), review || row.review ? 1 : 0, id).run();
  return json({ ok: true, photos: merged });
}

/* ================= admin ================= */
async function admin(req, env, action) {
  if (!isAdmin(req, env)) return json({ error: 'bad admin code' }, 403);
  const body = (await req.json().catch(() => ({}))) || {};

  // Used by the passcode prompt: reaching here at all means the code matched.
  if (action === 'check') return json({ ok: true });

  if (action === 'hide') {
    if (!body.id) return bad('id required');
    await env.DB.prepare('UPDATE listings SET hidden = ? WHERE id = ?')
      .bind(body.hidden ? 1 : 0, body.id).run();
    return json({ ok: true });
  }

  if (action === 'delete') {
    if (!body.id) return bad('id required');
    const row = await env.DB.prepare('SELECT photos, cover FROM listings WHERE id = ?').bind(body.id).first();
    if (row) {
      for (const pid of JSON.parse(row.photos || '[]')) await env.PHOTOS.delete(PHOTO_PREFIX + pid);
      if (row.cover) await env.PHOTOS.delete(PHOTO_PREFIX + row.cover);
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM listings WHERE id = ?').bind(body.id),
      env.DB.prepare('DELETE FROM votes WHERE listing_id = ?').bind(body.id),
      env.DB.prepare('DELETE FROM ballots WHERE listing_id = ?').bind(body.id),
    ]);
    return json({ ok: true });
  }

  if (action === 'cfg') {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('cfg', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(JSON.stringify(body.cfg || {})).run();
    return json({ ok: true });
  }

  if (action === 'wipe') {
    // Photo keys are listed rather than derived, so nothing is orphaned in KV.
    let cursor;
    do {
      const page = await env.PHOTOS.list({ prefix: PHOTO_PREFIX, cursor });
      for (const k of page.keys) await env.PHOTOS.delete(k.name);
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM listings'),
      env.DB.prepare('DELETE FROM votes'),
      env.DB.prepare('DELETE FROM ballots'),
      env.DB.prepare('DELETE FROM submissions'),
    ]);
    return json({ ok: true });
  }

  if (action === 'seed') {
    const rows = Array.isArray(body.listings) ? body.listings : [];
    const stmts = [];
    for (const d of rows) {
      const pids = [];
      for (let j = 0; j < (d.photos || []).length; j++) {
        const pid = await putPhoto(env, `${d.id}-${j}`, d.photos[j], true);
        if (pid) pids.push(pid);
      }
      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO listings (id, lat, lng, nick, ts, hidden, review, demo, trust, cover, photos, email, owner)
           VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?, '', 'seed')`
        ).bind(d.id, d.lat, d.lng, d.nick || '', d.ts, d.review ? 1 : 0, d.trust || 'manual',
               pids[0] || null, JSON.stringify(pids)),
        env.DB.prepare('INSERT OR REPLACE INTO votes (listing_id, remote, in_person) VALUES (?, ?, ?)')
          .bind(d.id, d.r || 0, d.p || 0)
      );
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, seeded: rows.length });
  }

  if (action === 'unseed') {
    const { results } = await env.DB.prepare('SELECT id, photos, cover FROM listings WHERE demo = 1').all();
    for (const row of results) {
      for (const pid of JSON.parse(row.photos || '[]')) await env.PHOTOS.delete(PHOTO_PREFIX + pid);
      if (row.cover) await env.PHOTOS.delete(PHOTO_PREFIX + row.cover);
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM votes WHERE listing_id IN (SELECT id FROM listings WHERE demo = 1)'),
      env.DB.prepare('DELETE FROM ballots WHERE listing_id IN (SELECT id FROM listings WHERE demo = 1)'),
      env.DB.prepare('DELETE FROM listings WHERE demo = 1'),
    ]);
    return json({ ok: true });
  }

  return bad('unknown admin action', 404);
}

/* ================= router ================= */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    // HEAD is a GET whose body the runtime discards for us.
    const method = req.method === 'HEAD' ? 'GET' : req.method;

    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);

    try {
      if (path.startsWith('/api/photo/') && method === 'GET') {
        return await getPhoto(env, decodeURIComponent(path.slice('/api/photo/'.length)));
      }
      if (path === '/api/state' && method === 'GET') return await getState(env);
      if (path === '/api/scan' && method === 'POST') return await scanPhoto(req, env);
      if (path === '/api/vote' && method === 'POST') return await castVote(req, env);
      if (path === '/api/submit' && method === 'POST') return await submit(req, env);
      if (path === '/api/photos' && method === 'POST') return await addPhotos(req, env);
      if (path.startsWith('/api/admin/') && method === 'POST') {
        return await admin(req, env, path.slice('/api/admin/'.length));
      }
      return bad('not found', 404);
    } catch (err) {
      console.error(path, err);
      return json({ error: 'server error' }, 500);
    }
  },
};
