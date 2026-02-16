CREATE TABLE IF NOT EXISTS world_tiles (
  q INTEGER NOT NULL,
  r INTEGER NOT NULL,
  owner_id TEXT,
  owner_alliance_tag TEXT,
  owner_alliance_color TEXT,
  energy DOUBLE PRECISION NOT NULL,
  integrity DOUBLE PRECISION NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  tile_type TEXT NOT NULL DEFAULT 'normal',
  last_update BIGINT NOT NULL,
  PRIMARY KEY (q, r)
);

CREATE INDEX IF NOT EXISTS idx_world_tiles_owner_id
  ON world_tiles (owner_id);

CREATE INDEX IF NOT EXISTS idx_world_tiles_last_update
  ON world_tiles (last_update);
