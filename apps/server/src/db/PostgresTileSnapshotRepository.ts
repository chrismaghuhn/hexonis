import type { Pool } from "pg";

import type { TileSnapshotRepository, TileState } from "../game/TileManager";

export class PostgresTileSnapshotRepository implements TileSnapshotRepository {
  constructor(private readonly pool: Pool) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
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
      )
    `);

    await this.pool.query(`
      ALTER TABLE world_tiles
      ADD COLUMN IF NOT EXISTS level INTEGER NOT NULL DEFAULT 1
    `);

    await this.pool.query(`
      ALTER TABLE world_tiles
      ADD COLUMN IF NOT EXISTS tile_type TEXT NOT NULL DEFAULT 'normal'
    `);

    await this.pool.query(`
      ALTER TABLE world_tiles
      ADD COLUMN IF NOT EXISTS owner_alliance_tag TEXT
    `);

    await this.pool.query(`
      ALTER TABLE world_tiles
      ADD COLUMN IF NOT EXISTS owner_alliance_color TEXT
    `);
  }

  async upsertTiles(tiles: TileState[]): Promise<void> {
    if (tiles.length === 0) {
      return;
    }

    const values: Array<number | string | null> = [];
    const placeholders: string[] = [];

    for (let index = 0; index < tiles.length; index += 1) {
      const tile = tiles[index];
      const parameterOffset = index * 10;

      placeholders.push(
        `($${parameterOffset + 1}, $${parameterOffset + 2}, $${parameterOffset + 3}, $${parameterOffset + 4}, $${parameterOffset + 5}, $${parameterOffset + 6}, $${parameterOffset + 7}, $${parameterOffset + 8}, $${parameterOffset + 9}, $${parameterOffset + 10})`,
      );

      values.push(
        tile.q,
        tile.r,
        tile.ownerId,
        tile.ownerAllianceTag,
        tile.ownerAllianceColor,
        tile.energy,
        tile.integrity,
        tile.level,
        tile.tileType,
        tile.lastUpdate,
      );
    }

    await this.pool.query(
      `
        INSERT INTO world_tiles (
          q,
          r,
          owner_id,
          owner_alliance_tag,
          owner_alliance_color,
          energy,
          integrity,
          level,
          tile_type,
          last_update
        )
        VALUES ${placeholders.join(",")}
        ON CONFLICT (q, r)
        DO UPDATE SET
          owner_id = EXCLUDED.owner_id,
          owner_alliance_tag = EXCLUDED.owner_alliance_tag,
          owner_alliance_color = EXCLUDED.owner_alliance_color,
          energy = EXCLUDED.energy,
          integrity = EXCLUDED.integrity,
          level = EXCLUDED.level,
          tile_type = EXCLUDED.tile_type,
          last_update = EXCLUDED.last_update
      `,
      values,
    );
  }
}
