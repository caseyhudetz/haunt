-- The Haunt. Apply with:
--   npx wrangler d1 execute haunt --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS houses (
  id       TEXT PRIMARY KEY,
  name     TEXT    NOT NULL,
  location TEXT    NOT NULL DEFAULT '',
  photos   TEXT    NOT NULL DEFAULT '[]',  -- JSON array of photo ids; first is the cover
  created  INTEGER NOT NULL
);

-- One row per device: the voter column is the primary key, so each phone has
-- exactly one pick, and changing it is an upsert.
CREATE TABLE IF NOT EXISTS votes (
  voter    TEXT PRIMARY KEY,
  house_id TEXT    NOT NULL,
  ts       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS votes_house ON votes (house_id);
