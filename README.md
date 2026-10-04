# The Haunt

East Lakeview's Halloween house contest. Neighbors flip through the houses and
pick a favorite; the winner gets a lawn sign.

- **`/`** shows the gallery, the voting, and the results once voting closes
- **`/h/<id>`** is one house, which is the link to share for it
- **`/admin`** is where you add, edit and remove houses (behind a passcode)

## How it works

- **One pick per phone.** No sign-in. Anyone can change their pick, or take it
  back, until the deadline.
- **Counts are hidden until voting closes.** The server doesn't send them before
  then, so there's no early leader to pile onto. Admin sees them all along.
- **Deadline:** `VOTING_ENDS` in `wrangler.jsonc`, currently Oct 31, 11:59 PM
  Chicago time. After it, voting stops and the page shows the winner (ties
  share first place).
- **Link previews:** shared links show the house's cover photo and name in
  texts and group chats.

| File | What it is |
|---|---|
| `public/index.html` | The page neighbors see |
| `public/admin.html` | Your admin page |
| `src/index.js` | The Cloudflare Worker: API, photos, link previews |
| `schema.sql` | Database tables |

Houses and votes live in Cloudflare **D1**; photos live in **KV**. Photos are
resized on your phone before upload (a 12MP shot becomes ~60KB, plus a ~15KB
version for the grid).

## One-time setup

```bash
npm install
npx wrangler login

npx wrangler d1 create haunt              # copy database_id into wrangler.jsonc
npx wrangler kv namespace create PHOTOS   # copy id into wrangler.jsonc
npx wrangler d1 execute haunt --remote --file=./schema.sql
npx wrangler secret put ADMIN_CODE        # pick your admin passcode
npx wrangler deploy
```

Deploying from the Cloudflare dashboard instead? Do the first three commands once,
commit the two ids, and set `ADMIN_CODE` under the Worker's
**Settings → Variables and Secrets**.

## Local development

```bash
echo 'ADMIN_CODE=1031' > .dev.vars        # gitignored
npx wrangler d1 execute haunt --local --file=./schema.sql
npx wrangler dev
```

To preview the results screen, add `VOTING_ENDS=2026-10-01T00:00:00-05:00` to
`.dev.vars` and restart.
