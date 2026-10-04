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

Houses and votes live in Cloudflare **D1**; photos live in **KV**. Photos are
resized on your phone before upload (a 12MP shot becomes ~60KB, plus a ~15KB
version for the grid).

## Going live

There are no IDs to copy and no schema to run. On the first deploy, wrangler
creates the D1 database and the photo store and attaches them to the Worker;
later deploys reuse them. The Worker creates its own tables on the first request.

**From the Cloudflare dashboard** (this repo is already connected via Workers Builds):

1. Get this code onto the branch the dashboard builds from (usually `main`).
   The push triggers the deploy.
2. In the Worker's **Settings → Variables and Secrets**, add a **Secret**
   named `ADMIN_CODE` with your passcode. Until it's set, `/admin` stays locked.

The `name` in `wrangler.jsonc` (`haunt`) must match the Worker's name in the
dashboard, or the build stops with a name-mismatch error.

**From a terminal**, the same thing:

```bash
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put ADMIN_CODE
```

## Local development

```bash
echo 'ADMIN_CODE=1031' > .dev.vars        # gitignored
npx wrangler dev
```

To preview the results screen, add `VOTING_ENDS=2026-10-01T00:00:00-05:00` to
`.dev.vars` and restart.
