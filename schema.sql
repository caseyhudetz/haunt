-- The Haunt: D1 schema. Apply with:
--   npx wrangler d1 execute haunt --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS listings (
  id      TEXT PRIMARY KEY,
  lat     REAL    NOT NULL,
  lng     REAL    NOT NULL,
  nick    TEXT    NOT NULL DEFAULT '',
  ts      INTEGER NOT NULL,
  hidden  INTEGER NOT NULL DEFAULT 0,
  review  INTEGER NOT NULL DEFAULT 0,
  demo    INTEGER NOT NULL DEFAULT 0,
  trust   TEXT    NOT NULL DEFAULT 'manual',
  cover   TEXT,                            -- photo id, served from /api/photo/<id>
  photos  TEXT    NOT NULL DEFAULT '[]',   -- JSON array of photo ids
  email   TEXT    NOT NULL DEFAULT '',
  owner   TEXT    NOT NULL DEFAULT ''      -- device token that submitted it
);

-- One row per listing. Incremented atomically alongside a ballot insert.
CREATE TABLE IF NOT EXISTS votes (
  listing_id TEXT PRIMARY KEY,
  remote     INTEGER NOT NULL DEFAULT 0,
  in_person  INTEGER NOT NULL DEFAULT 0
);

-- The primary key is what actually stops double voting: a second ballot from
-- the same device for the same listing violates it and rolls the batch back.
CREATE TABLE IF NOT EXISTS ballots (
  listing_id TEXT    NOT NULL,
  voter      TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (listing_id, voter)
);

-- Backs the per-device daily submission cap.
CREATE TABLE IF NOT EXISTS submissions (
  voter TEXT    NOT NULL,
  ts    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS submissions_voter_ts ON submissions (voter, ts);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
