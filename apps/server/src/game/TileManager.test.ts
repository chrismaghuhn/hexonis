import { describe, expect, it } from "vitest";

import {
  type RedisTileStore,
  TileManager,
  type TileSnapshotRepository,
  type TileState,
} from "./TileManager";

class InMemoryRedis implements RedisTileStore {
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly sortedSets = new Map<string, Map<string, number>>();

  async hGetAll(key: string): Promise<Record<string, string>> {
    const hash = this.hashes.get(key);

    if (!hash) {
      return {};
    }

    return Object.fromEntries(hash.entries());
  }

  async hSet(key: string, values: Record<string, string | number>): Promise<number> {
    let hash = this.hashes.get(key);

    if (!hash) {
      hash = new Map<string, string>();
      this.hashes.set(key, hash);
    }

    let updated = 0;

    for (const [field, value] of Object.entries(values)) {
      hash.set(field, String(value));
      updated += 1;
    }

    return updated;
  }

  async hIncrBy(key: string, field: string, increment: number): Promise<number> {
    let hash = this.hashes.get(key);

    if (!hash) {
      hash = new Map<string, string>();
      this.hashes.set(key, hash);
    }

    const current = Number(hash.get(field) ?? 0);
    const next = current + increment;
    hash.set(field, String(next));
    return next;
  }

  async hSetNX(key: string, field: string, value: string): Promise<number> {
    let hash = this.hashes.get(key);

    if (!hash) {
      hash = new Map<string, string>();
      this.hashes.set(key, hash);
    }

    if (hash.has(field)) {
      return 0;
    }

    hash.set(field, value);
    return 1;
  }

  async zIncrBy(key: string, increment: number, member: string): Promise<number> {
    let set = this.sortedSets.get(key);

    if (!set) {
      set = new Map<string, number>();
      this.sortedSets.set(key, set);
    }

    const current = set.get(member) ?? 0;
    const next = current + increment;
    set.set(member, next);
    return next;
  }

  async zRangeWithScores(
    key: string,
    min: number,
    max: number,
    options?: { REV?: boolean },
  ): Promise<Array<{ value: string; score: number }>> {
    const set = this.sortedSets.get(key);

    if (!set) {
      return [];
    }

    const entries = [...set.entries()].map(([value, score]) => ({ value, score }));
    entries.sort((a, b) => (options?.REV ? b.score - a.score : a.score - b.score));

    return entries.slice(min, max + 1);
  }

  async sAdd(key: string, ...members: string[]): Promise<number> {
    let set = this.sets.get(key);

    if (!set) {
      set = new Set<string>();
      this.sets.set(key, set);
    }

    let added = 0;

    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        added += 1;
      }
    }

    return added;
  }

  async sRem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);

    if (!set) {
      return 0;
    }

    let removed = 0;

    for (const member of members) {
      if (set.delete(member)) {
        removed += 1;
      }
    }

    return removed;
  }

  async sMembers(key: string): Promise<string[]> {
    const set = this.sets.get(key);

    if (!set) {
      return [];
    }

    return [...set.values()];
  }

  async sScan(
    key: string,
    cursor: string,
    options?: { COUNT?: number },
  ): Promise<{ cursor: string; members: string[] }> {
    const set = this.sets.get(key);

    if (!set) {
      return { cursor: "0", members: [] };
    }

    const count = options?.COUNT ?? 10;
    const orderedMembers = [...set.values()].sort();
    const start = Number(cursor);
    const end = Math.min(start + count, orderedMembers.length);
    const nextCursor = end >= orderedMembers.length ? "0" : String(end);

    return {
      cursor: nextCursor,
      members: orderedMembers.slice(start, end),
    };
  }
}

class SnapshotCollector implements TileSnapshotRepository {
  readonly batches: TileState[][] = [];

  async upsertTiles(tiles: TileState[]): Promise<void> {
    this.batches.push(tiles.map((tile) => ({ ...tile })));
  }
}

describe("TileManager", () => {
  it("charges 10 energy for free tile claims", async () => {
    const redis = new InMemoryRedis();
    const manager = new TileManager({ redis });

    const result = await manager.claimTile("player-a", 2, -1);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.energyCost).toBe(10);
    expect(result.energyAfter).toBe(90);
    expect(result.created).toBe(true);
    expect(result.tile.ownerId).toBe("player-a");
    expect(await manager.getPlayerEnergy("player-a")).toBe(90);
  });

  it("charges level * 50 to capture enemy tiles", async () => {
    const redis = new InMemoryRedis();
    const manager = new TileManager({
      redis,
      options: {
        initialPlayerEnergy: 200,
      },
    });

    await manager.claimTile("player-a", 3, -1);
    await redis.hSet("tile:3:-1", { level: 3 });

    const result = await manager.claimTile("player-b", 3, -1);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.captured).toBe(true);
    expect(result.energyCost).toBe(150);
    expect(result.energyAfter).toBe(50);
    expect(result.tile.ownerId).toBe("player-b");
  });

  it("returns insufficient-energy when claim cost is too high", async () => {
    const redis = new InMemoryRedis();
    const manager = new TileManager({
      redis,
      options: {
        initialPlayerEnergy: 20,
      },
    });

    await manager.claimTile("player-a", 0, 0);
    const result = await manager.claimTile("player-b", 0, 0);

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.reason).toBe("insufficient-energy");
    if (result.reason === "insufficient-energy") {
      expect(result.requiredEnergy).toBe(50);
    }
    expect(result.playerEnergy).toBe(20);
  });

  it("rejects teleport claims outside allowed territory range", async () => {
    const redis = new InMemoryRedis();
    const manager = new TileManager({
      redis,
      options: {
        maxClaimDistanceFromOwned: 2,
      },
    });

    await manager.claimTile("player-a", 0, 0);
    const result = await manager.claimTile("player-a", 8, 0);

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.reason).toBe("out-of-range");
    if (result.reason === "out-of-range") {
      expect(result.maxDistance).toBe(2);
      expect(result.nearestDistance).toBe(8);
    }
  });

  it("updates leaderboard scores when tiles are captured", async () => {
    const redis = new InMemoryRedis();
    const manager = new TileManager({
      redis,
      options: {
        initialPlayerEnergy: 500,
      },
    });

    await manager.claimTile("player-a", 0, 0);
    await manager.claimTile("player-a", 1, 0);
    await manager.claimTile("player-b", 2, 0);
    await manager.claimTile("player-b", 1, 0);

    const leaderboard = await manager.getLeaderboard();

    expect(leaderboard[0]?.userId).toBe("player-b");
    expect(leaderboard[0]?.score).toBe(2);
    expect(leaderboard[1]?.userId).toBe("player-a");
    expect(leaderboard[1]?.score).toBe(1);
  });

  it("applies alliance tag and color to owned tiles", async () => {
    const redis = new InMemoryRedis();
    const manager = new TileManager({ redis });

    await manager.claimTile("player-a", 2, 2);
    const profile = await manager.setAllianceTag("player-a", "AX3");
    const [tile] = await manager.get_tiles_in_range(2, 2, 0);

    expect(profile.allianceTag).toBe("AX3");
    expect(profile.allianceColor).toMatch(/^#[0-9A-F]{6}$/);
    expect(tile.ownerAllianceTag).toBe("AX3");
    expect(tile.ownerAllianceColor).toBe(profile.allianceColor);
  });

  it("repairs tile integrity by spending 5 energy", async () => {
    const redis = new InMemoryRedis();
    const manager = new TileManager({ redis });

    await manager.claimTile("player-a", 1, 1);
    await redis.hSet("tile:1:1", { integrity: 40 });

    const result = await manager.repairTile("player-a", 1, 1);

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.energyCost).toBe(5);
    expect(result.energyAfter).toBe(85);
    expect(result.tile.integrity).toBe(60);
  });

  it("applies entropy and stops energy generation at zero integrity", async () => {
    const redis = new InMemoryRedis();
    const manager = new TileManager({
      redis,
      options: {
        maxEnergy: 1000,
        energyRechargePerSecond: 1,
      },
    });

    await manager.claimTile("player-a", 0, 0);
    await redis.hSet("tile:0:0", {
      ownerId: "player-a",
      energy: 0,
      integrity: 1,
      lastUpdate: 0,
      level: 1,
    });

    await manager.rechargeEnergy(60_000);

    const [firstTickTile] = await manager.get_tiles_in_range(0, 0, 0);
    const energyAfterFirstTick = await manager.getPlayerEnergy("player-a");

    expect(firstTickTile.integrity).toBe(0);
    expect(firstTickTile.energy).toBe(60);
    expect(energyAfterFirstTick).toBeGreaterThan(90);

    await manager.rechargeEnergy(120_000);
    const [secondTickTile] = await manager.get_tiles_in_range(0, 0, 0);
    const energyAfterSecondTick = await manager.getPlayerEnergy("player-a");

    expect(secondTickTile.energy).toBe(60);
    expect(secondTickTile.integrity).toBe(0);
    expect(energyAfterSecondTick).toBe(energyAfterFirstTick);
  });

  it("applies +5% recharge bonus for adjacent alliance members", async () => {
    const redis = new InMemoryRedis();
    const manager = new TileManager({
      redis,
      options: {
        initialPlayerEnergy: 500,
        maxEnergy: 1000,
      },
    });

    await manager.claimTile("player-a", 0, 0);
    await manager.claimTile("player-b", 1, 0);
    await manager.setAllianceTag("player-a", "FOX");
    await manager.setAllianceTag("player-b", "FOX");

    await redis.hSet("tile:0:0", {
      ownerId: "player-a",
      energy: 0,
      integrity: 100,
      lastUpdate: 0,
      level: 1,
      tileType: "normal",
    });
    await redis.hSet("tile:1:0", {
      ownerId: "player-b",
      energy: 0,
      integrity: 100,
      lastUpdate: 0,
      level: 1,
      tileType: "normal",
    });

    await manager.rechargeEnergy(60_000);

    const energyA = await manager.getPlayerEnergy("player-a");
    const energyB = await manager.getPlayerEnergy("player-b");

    expect(energyA).toBe(553);
    expect(energyB).toBe(553);
  });

  it("returns only tiles inside radius", async () => {
    const redis = new InMemoryRedis();
    const manager = new TileManager({ redis, options: { chunkSize: 2 } });

    await manager.claimTile("player-a", 0, 0);
    await manager.claimTile("player-a", 1, 0);
    await manager.claimTile("player-a", 0, 1);
    await manager.claimTile("player-a", 3, -1);

    const visibleTiles = await manager.get_tiles_in_range(0, 0, 1);
    const visibleCoordinates = new Set(visibleTiles.map((tile) => `${tile.q}:${tile.r}`));

    expect(visibleCoordinates).toEqual(new Set(["0:0", "1:0", "0:1"]));
  });

  it("builds radar summary with nexus cores, bases, and hotspots", async () => {
    const redis = new InMemoryRedis();
    const manager = new TileManager({
      redis,
      options: {
        chunkSize: 10,
      },
    });

    await manager.registerNexus(20, 0, 4);
    await manager.claimTile("player-a", 0, 0);
    await manager.claimTile("player-a", 1, 0);
    await manager.claimTile("player-b", 20, 0);

    const radar = await manager.get_radar_summary("player-a", 0, 0, 500);

    expect(radar.nexusCores).toEqual([{ q: 20, r: 0, level: 4 }]);
    expect(radar.playerBases.some((base) => base.q === 0 && base.r === 0)).toBe(true);
    expect(radar.hotspots.length).toBeGreaterThan(0);
  });

  it("flushes tile snapshots to persistence in batches", async () => {
    const redis = new InMemoryRedis();
    const snapshots = new SnapshotCollector();
    const manager = new TileManager({
      redis,
      snapshotRepository: snapshots,
      options: {
        snapshotBatchSize: 2,
      },
    });

    await manager.claimTile("player-a", 0, 0);
    await manager.claimTile("player-a", 1, 0);
    await manager.claimTile("player-a", 1, -1);

    const persisted = await manager.flushSnapshotToPostgres();

    expect(persisted).toBe(3);
    expect(snapshots.batches).toHaveLength(2);
    expect(snapshots.batches[0]).toHaveLength(2);
    expect(snapshots.batches[1]).toHaveLength(1);
  });

  it("rejects non-integer coordinates", async () => {
    const redis = new InMemoryRedis();
    const manager = new TileManager({ redis });

    await expect(manager.claimTile("player-a", 0.5, 1)).rejects.toThrow(
      "q and r must be integer axial coordinates",
    );
  });
});
