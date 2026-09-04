# The Haunt

A neighborhood Halloween decoration contest, as a single-page mobile web app on
Cloudflare Workers. Photos are moderated by Claude before they reach the map.

- `public/index.html` — the whole client (no build step)
- `src/index.js` — the Worker: JSON API + static asset serving
- `schema.sql` — D1 tables

## How state is stored

| Data | Where | Why |
|---|---|---|
| Listings, vote tallies, ballots, settings | **D1** (`DB`) | Needs to be strongly consistent and updated atomically — two people voting at once must not clobber each other. |
| Photo bytes | **KV** (`PHOTOS`) | Written once and never edited, so eventual consistency is free, and the value ceiling is far above any submission. Served from `/api/photo/<id>` with a long cache. |
| Which listings *this browser* voted on | `localStorage` | A per-device convenience. The server holds the authoritative ballot record. |

Double voting is prevented by the `(listing_id, voter)` primary key on `ballots`,
not by the browser: the ballot insert and the tally increment run in one D1 batch,
so a repeat vote rolls the whole thing back.

## First-time setup

```bash
npm install

# 1. Create the two stores
npx wrangler d1 create haunt          # copy database_id into wrangler.jsonc
npx wrangler kv namespace create PHOTOS   # copy id into wrangler.jsonc

# 2. Create the tables
npx wrangler d1 execute haunt --remote --file=./schema.sql

# 3. Secrets (never committed)
npx wrangler secret put ANTHROPIC_API_KEY   # photo moderation
npx wrangler secret put ADMIN_CODE          # unlocks the admin panel

# 4. Ship
npx wrangler deploy
```

`wrangler.jsonc` ships with placeholder ids for `database_id` and the KV
namespace — **deploy fails until you replace both** with the values printed by
the `create` commands above.

If you deploy from the Cloudflare dashboard (Workers Builds) rather than the CLI,
set the two secrets under **Settings → Variables and Secrets** instead of step 3.

## Local development

```bash
echo 'ADMIN_CODE=1031' > .dev.vars    # gitignored
npx wrangler d1 execute haunt --local --file=./schema.sql
npx wrangler dev
```

Without `ANTHROPIC_API_KEY` the scan endpoint returns `{ok: false}` and the app
flags every photo for human review rather than silently approving it.

## API

| Route | Purpose |
|---|---|
| `GET /api/state` | The whole board: config, listings, tallies |
| `GET /api/photo/<id>` | One photo, immutably cached |
| `POST /api/scan` | Moderation — proxies to Claude so the key stays server-side |
| `POST /api/vote` | Atomic, deduplicated by device token |
| `POST /api/submit` | New listing; enforces the 5-per-day cap server-side |
| `POST /api/photos` | Add photos to an existing listing |
| `POST /api/admin/*` | `check`, `hide`, `delete`, `cfg`, `wipe`, `seed`, `unseed` — all require the `ADMIN_CODE` header |

## Moderation

`POST /api/scan` sends the photo to `claude-opus-5` with a JSON schema
(`output_config.format`), so the verdict is always well-formed. The model is
asked whether the shot is an outdoor decorated house, whether anyone —
especially a child — is visible, whether it is a screenshot, and for two
nicknames. Anything it declines to describe is treated as a block.

Failures degrade safely: a scan error returns `{ok: false}`, and the client
marks that photo "could not be checked automatically" and flags it for review.
