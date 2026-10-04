/* ================= schema =================
   The Worker creates its own tables, so a fresh deploy needs no setup step.
   CREATE ... IF NOT EXISTS is a no-op once they exist, and it runs once per
   Worker instance rather than once per request. */
let schemaReady = null;
function ensureSchema(env) {
  schemaReady ??= env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS houses (
      id       TEXT PRIMARY KEY,
      name     TEXT    NOT NULL,
      location TEXT    NOT NULL DEFAULT '',
      photos   TEXT    NOT NULL DEFAULT '[]',
      created  INTEGER NOT NULL
    )`),
    // voter is the primary key, so each phone has exactly one pick and
    // changing it is an upsert.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS votes (
      voter    TEXT PRIMARY KEY,
      house_id TEXT    NOT NULL,
      ts       INTEGER NOT NULL
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS votes_house ON votes (house_id)'),
  ]).catch((err) => {
    schemaReady = null; // let the next request try again
    throw err;
  });
  return schemaReady;
}

/* ================= helpers ================= */
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
const bad = (error, status = 400) => json({ error }, status);

const endsAt = (env) => new Date(env.VOTING_ENDS || '2026-10-31T23:59:00-05:00').getTime();
const isClosed = (env) => Date.now() > endsAt(env);

// An anonymous per-browser id. It keeps honest people to one pick; it is not
// meant to stop anyone determined, which is fine for a lawn-sign prize.
const voterOf = (req) => (req.headers.get('x-voter') || '').slice(0, 64);

function codeMatches(given, expected) {
  if (!expected || typeof given !== 'string' || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
const isAdmin = (req, env) => codeMatches(req.headers.get('x-admin') || '', env.ADMIN_CODE);

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

const toHouse = (r) => ({
  id: r.id,
  name: r.name,
  location: r.location,
  photos: JSON.parse(r.photos || '[]'),
  created: r.created,
});

async function allHouses(env) {
  const { results } = await env.DB.prepare('SELECT * FROM houses ORDER BY created ASC').all();
  return results.map(toHouse);
}

async function voteCounts(env) {
  const { results } = await env.DB.prepare(
    'SELECT house_id, COUNT(*) AS n FROM votes GROUP BY house_id'
  ).all();
  const counts = {};
  for (const r of results) counts[r.house_id] = r.n;
  return counts;
}

/* ================= photos =================
   The admin page resizes on the phone and sends two JPEGs per photo: a full
   size for the detail view and a small one for the gallery grid. */
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

function decodeJpeg(dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return null;
  const bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
  // Check the JPEG signature rather than trusting the label.
  if (bytes.length > MAX_PHOTO_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  return bytes;
}

// Returns one entry per input, null where the upload wasn't a usable JPEG, so
// callers can match results back to positions.
async function storePhotos(env, list) {
  const ids = [];
  for (const p of Array.isArray(list) ? list : []) {
    const full = decodeJpeg(p && p.full);
    const thumb = decodeJpeg(p && p.thumb);
    if (!full || !thumb) { ids.push(null); continue; }
    const id = newId();
    await env.PHOTOS.put('full:' + id, full);
    await env.PHOTOS.put('thumb:' + id, thumb);
    ids.push(id);
  }
  return ids;
}

async function deletePhotos(env, ids) {
  for (const id of ids) {
    await env.PHOTOS.delete('full:' + id);
    await env.PHOTOS.delete('thumb:' + id);
  }
}

async function servePhoto(env, id, size) {
  const bytes = await env.PHOTOS.get(size + ':' + id, 'arrayBuffer');
  if (!bytes) return new Response('Not found', { status: 404 });
  return new Response(bytes, {
    headers: {
      'content-type': 'image/jpeg',
      // Ids are never reused, so a photo at a given URL never changes.
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}

/* ================= public api ================= */
async function getBoard(req, env) {
  const voter = voterOf(req);
  const closed = isClosed(env);
  const [houses, mine] = await Promise.all([
    allHouses(env),
    voter ? env.DB.prepare('SELECT house_id FROM votes WHERE voter = ?').bind(voter).first() : null,
  ]);
  return json({
    houses,
    endsAt: endsAt(env),
    closed,
    myVote: mine ? mine.house_id : null,
    // Tallies stay on the server until voting closes, so there is no early
    // leader to pile onto and the reveal means something.
    counts: closed ? await voteCounts(env) : null,
  });
}

async function castVote(req, env) {
  if (isClosed(env)) return bad('Voting is closed.', 403);
  const voter = voterOf(req);
  if (!voter) return bad('missing voter id');
  const { houseId } = (await req.json().catch(() => ({}))) || {};

  if (houseId === null) {
    await env.DB.prepare('DELETE FROM votes WHERE voter = ?').bind(voter).run();
    return json({ ok: true, myVote: null });
  }

  const house = await env.DB.prepare('SELECT id FROM houses WHERE id = ?').bind(houseId || '').first();
  if (!house) return bad('That house is not in the contest.', 404);

  await env.DB.prepare(
    `INSERT INTO votes (voter, house_id, ts) VALUES (?, ?, ?)
     ON CONFLICT(voter) DO UPDATE SET house_id = excluded.house_id, ts = excluded.ts`
  ).bind(voter, houseId, Date.now()).run();
  return json({ ok: true, myVote: houseId });
}

/* ================= admin api ================= */
async function admin(req, env, rest, method) {
  if (!isAdmin(req, env)) return bad('Wrong passcode.', 403);

  if (rest === 'check' && method === 'POST') return json({ ok: true });

  if (rest === 'houses' && method === 'GET') {
    const [houses, counts] = await Promise.all([allHouses(env), voteCounts(env)]);
    return json({ houses, counts, endsAt: endsAt(env), closed: isClosed(env) });
  }

  if (rest === 'houses' && method === 'POST') {
    const body = (await req.json().catch(() => null)) || {};
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) return bad('Give the house a name.');
    const photos = (await storePhotos(env, body.newPhotos)).filter(Boolean);
    if (!photos.length) return bad('Add at least one photo.');
    const house = {
      id: newId(),
      name,
      location: String(body.location || '').trim().slice(0, 120),
      photos,
      created: Date.now(),
    };
    await env.DB.prepare('INSERT INTO houses (id, name, location, photos, created) VALUES (?, ?, ?, ?, ?)')
      .bind(house.id, house.name, house.location, JSON.stringify(house.photos), house.created).run();
    return json({ ok: true, house });
  }

  const m = /^houses\/([a-z0-9]+)$/.exec(rest);
  if (!m) return bad('not found', 404);
  const row = await env.DB.prepare('SELECT * FROM houses WHERE id = ?').bind(m[1]).first();
  if (!row) return bad('No such house.', 404);
  const house = toHouse(row);

  if (method === 'PUT') {
    const body = (await req.json().catch(() => null)) || {};
    const name = String(body.name ?? house.name).trim().slice(0, 60);
    if (!name) return bad('Give the house a name.');
    // `order` is the final photo list as shown on the admin's screen: existing
    // ids, plus "new:<n>" for the n-th entry of newPhotos. Existing photos that
    // aren't in it were removed and get deleted.
    const added = await storePhotos(env, body.newPhotos);
    const order = Array.isArray(body.order) ? body.order : house.photos;
    const photos = order
      .map((t) => (typeof t === 'string' && t.startsWith('new:') ? added[+t.slice(4)] : house.photos.includes(t) ? t : null))
      .filter(Boolean);
    const keep = photos.filter((id) => house.photos.includes(id));
    if (!photos.length) {
      await deletePhotos(env, added.filter(Boolean));
      return bad('A house needs at least one photo.');
    }
    await deletePhotos(env, house.photos.filter((id) => !keep.includes(id)));
    await env.DB.prepare('UPDATE houses SET name = ?, location = ?, photos = ? WHERE id = ?')
      .bind(name, String(body.location ?? house.location).trim().slice(0, 120), JSON.stringify(photos), house.id)
      .run();
    return json({ ok: true });
  }

  if (method === 'DELETE') {
    await deletePhotos(env, house.photos);
    // Anyone who picked this house gets their vote back.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM votes WHERE house_id = ?').bind(house.id),
      env.DB.prepare('DELETE FROM houses WHERE id = ?').bind(house.id),
    ]);
    return json({ ok: true });
  }

  return bad('not found', 404);
}

/* ================= link previews =================
   Group chats and social apps read the page's meta tags without running any
   script, so the server fills them in: the first house's photo for the main
   link, that house's own photo and name for a /h/<id> link. */
async function servePage(req, env, houseId) {
  const url = new URL(req.url);
  const page = await env.ASSETS.fetch(new Request(new URL('/', url), req));
  let title = 'The Haunt · East Lakeview';
  let description = 'Vote for your favorite Halloween house in East Lakeview.';
  let image = '';

  try {
    if (houseId) {
      const row = await env.DB.prepare('SELECT * FROM houses WHERE id = ?').bind(houseId).first();
      if (row) {
        const h = toHouse(row);
        title = `${h.name} · The Haunt`;
        description = `One of the contenders for best Halloween house in East Lakeview. ${isClosed(env) ? 'See who won.' : 'Cast your vote.'}`;
        if (h.photos[0]) image = `${url.origin}/p/${h.photos[0]}`;
      }
    } else {
      const row = await env.DB.prepare('SELECT photos FROM houses ORDER BY created ASC LIMIT 1').first();
      const first = row && JSON.parse(row.photos || '[]')[0];
      if (first) image = `${url.origin}/p/${first}`;
    }
  } catch (err) {
    // A database hiccup should cost us a preview image, not the page.
    console.error('preview lookup failed', err);
  }

  const set = (value) => ({ element: (el) => el.setAttribute('content', value) });
  return new HTMLRewriter()
    .on('title', { element: (el) => el.setInnerContent(title) })
    .on('meta[property="og:title"]', set(title))
    .on('meta[property="og:description"]', set(description))
    .on('meta[name="description"]', set(description))
    .on('meta[property="og:url"]', set(url.href))
    .on('meta[property="og:image"]', { element: (el) => (image ? el.setAttribute('content', image) : el.remove()) })
    .transform(page);
}

/* ================= router ================= */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method === 'HEAD' ? 'GET' : req.method;

    try {
      // Every route below except static files touches the database.
      const needsDb = path === '/' || /^\/(h|p|api)\//.test(path);
      if (needsDb) await ensureSchema(env);

      if (method === 'GET' && path === '/') return await servePage(req, env, null);
      const house = /^\/h\/([a-z0-9]+)\/?$/.exec(path);
      if (method === 'GET' && house) return await servePage(req, env, house[1]);

      const photo = /^\/p\/([a-z0-9]+)(\/t)?$/.exec(path);
      if (method === 'GET' && photo) return await servePhoto(env, photo[1], photo[2] ? 'thumb' : 'full');

      if (path === '/api/board' && method === 'GET') return await getBoard(req, env);
      if (path === '/api/vote' && method === 'POST') return await castVote(req, env);
      if (path.startsWith('/api/admin/')) return await admin(req, env, path.slice('/api/admin/'.length), method);
      if (path.startsWith('/api/')) return bad('not found', 404);
    } catch (err) {
      console.error(path, err);
      return path.startsWith('/api/') ? json({ error: 'Something went wrong.' }, 500) : new Response('Something went wrong.', { status: 500 });
    }

    return env.ASSETS.fetch(req);
  },
};
