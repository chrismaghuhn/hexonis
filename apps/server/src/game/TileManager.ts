import {
  get_neighbors,
  hex_distance,
  hex_to_pixel,
  pixel_to_hex,
  type HexTile,
} from "@hexonis/shared/hexMath";
import type {
  LeaderboardEntry,
  PlayerProfilePayload,
  RadarDataPayload,
  RadarHotspotPoint,
  RadarNexusPoint,
  RadarPlayerBasePoint,
} from "@hexonis/shared/events";

const TILE_INDEX_KEY = "tiles:index";
const POI_INDEX_KEY = "poi:index";
const CHUNK_ACTIVITY_KEY = "chunk:activity";
const LEADERBOARD_TILES_KEY = "leaderboard:tiles";

type SScanResponse =
  | { cursor: string | number; members: string[] }
  | [string | number, string[]];

export interface RedisTileStore {
  hGetAll(key: string): Promise<Record<string, string>>;
  hSet(key: string, values: Record<string, string | number>): Promise<number>;
  hIncrBy(key: string, field: string, increment: number): Promise<number>;
  hSetNX(key: string, field: string, value: string): Promise<number>;
  zIncrBy(key: string, increment: number, member: string): Promise<number>;
  zRangeWithScores(
    key: string,
    min: number,
    max: number,
    options?: { REV?: boolean },
  ): Promise<Array<{ value?: string; member?: string; score: number }>>;
  sAdd(key: string, ...members: string[]): Promise<number>;
  sRem(key: string, ...members: string[]): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  sScan(
    key: string,
    cursor: string,
    options?: { COUNT?: number },
  ): Promise<SScanResponse>;
}

export type TileType = "normal" | "nexus";

export interface TileState extends HexTile {
  ownerId: string | null;
  ownerAllianceTag: string | null;
  ownerAllianceColor: string | null;
  energy: number;
  lastUpdate: number;
  integrity: number;
  level: number;
  tileType: TileType;
}

export interface TileSnapshotRepository {
  upsertTiles(tiles: TileState[]): Promise<void>;
}

export interface PlayerEnergyState {
  userId: string;
  displayName: string;
  allianceTag: string | null;
  allianceColor: string | null;
  energy: number;
  lastUpdate: number;
}

export interface TileManagerOptions {
  chunkSize?: number;
  maxEnergy?: number;
  maxPlayerEnergy?: number;
  initialTileEnergy?: number;
  initialTileIntegrity?: number;
  initialTileLevel?: number;
  initialPlayerEnergy?: number;
  energyRechargePerSecond?: number;
  integrityDecayPerMinute?: number;
  freeClaimCost?: number;
  hostileClaimCostMultiplier?: number;
  repairCostEnergy?: number;
  repairIntegrityGain?: number;
  maxClaimDistanceFromOwned?: number;
  allianceNeighborBonusMultiplier?: number;
  maxLeaderboardEntries?: number;
  maxRadarNexusPoints?: number;
  maxRadarBasePoints?: number;
  maxRadarHotspots?: number;
  rechargeIntervalMs?: number;
  snapshotIntervalMs?: number;
  snapshotBatchSize?: number;
}

export interface ClaimTileSuccess {
  ok: true;
  created: boolean;
  captured: boolean;
  tile: TileState;
  energyAfter: number;
  energyCost: number;
}

export interface ClaimTileAlreadyClaimed {
  ok: false;
  reason: "already-claimed";
  tile: TileState | null;
  playerEnergy: number;
}

export interface ClaimTileInsufficientEnergy {
  ok: false;
  reason: "insufficient-energy";
  tile: TileState | null;
  requiredEnergy: number;
  playerEnergy: number;
}

export interface ClaimTileOutOfRange {
  ok: false;
  reason: "out-of-range";
  tile: TileState | null;
  maxDistance: number;
  nearestDistance: number | null;
  playerEnergy: number;
}

export type ClaimTileResult =
  | ClaimTileSuccess
  | ClaimTileAlreadyClaimed
  | ClaimTileInsufficientEnergy
  | ClaimTileOutOfRange;

export interface RepairTileSuccess {
  ok: true;
  tile: TileState;
  energyAfter: number;
  energyCost: number;
}

export interface RepairTileFailure {
  ok: false;
  reason: "tile-not-found" | "not-owner" | "insufficient-energy";
  message: string;
  tile: TileState | null;
  requiredEnergy?: number;
  playerEnergy: number;
}

export type RepairTileResult = RepairTileSuccess | RepairTileFailure;

export interface TileManagerDependencies {
  redis: RedisTileStore;
  snapshotRepository?: TileSnapshotRepository;
  options?: TileManagerOptions;
  onBackgroundError?: (error: unknown) => void;
}

const DEFAULT_OPTIONS: Required<TileManagerOptions> = {
  chunkSize: 64,
  maxEnergy: 100,
  maxPlayerEnergy: 1000,
  initialTileEnergy: 100,
  initialTileIntegrity: 100,
  initialTileLevel: 1,
  initialPlayerEnergy: 100,
  energyRechargePerSecond: 1,
  integrityDecayPerMinute: 1,
  freeClaimCost: 10,
  hostileClaimCostMultiplier: 50,
  repairCostEnergy: 5,
  repairIntegrityGain: 20,
  maxClaimDistanceFromOwned: 8,
  allianceNeighborBonusMultiplier: 1.05,
  maxLeaderboardEntries: 10,
  maxRadarNexusPoints: 64,
  maxRadarBasePoints: 64,
  maxRadarHotspots: 32,
  rechargeIntervalMs: 1000,
  snapshotIntervalMs: 5 * 60 * 1000,
  snapshotBatchSize: 1000,
};

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

function toFixedPrecision(value: number, precision = 4): number {
  return Number(value.toFixed(precision));
}

function hasValues(hash: Record<string, string>): boolean {
  return Object.keys(hash).length > 0;
}

export class TileManager {
  private readonly redis: RedisTileStore;
  private readonly snapshotRepository?: TileSnapshotRepository;
  private readonly options: Required<TileManagerOptions>;
  private readonly onBackgroundError: (error: unknown) => void;
  private snapshotTimer?: ReturnType<typeof setInterval>;
  private rechargeTimer?: ReturnType<typeof setInterval>;

  constructor({
    redis,
    snapshotRepository,
    options,
    onBackgroundError,
  }: TileManagerDependencies) {
    this.redis = redis;
    this.snapshotRepository = snapshotRepository;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.onBackgroundError = onBackgroundError ?? (() => undefined);
  }

  async claimTile(userId: string, q: number, r: number): Promise<ClaimTileResult> {
    const normalizedUserId = this.normalizeUserId(userId);

    this.validateCoordinates(q, r);

    const now = Date.now();
    const key = this.tileKey(q, r);
    const currentTile = await this.loadTile(q, r);

    if (currentTile && currentTile.ownerId === normalizedUserId) {
      const playerEnergy = await this.getPlayerEnergy(normalizedUserId);

      return {
        ok: true,
        created: false,
        captured: false,
        tile: currentTile,
        energyAfter: playerEnergy,
        energyCost: 0,
      };
    }

    const rangeValidation = await this.validateClaimDistance(normalizedUserId, q, r);

    if (!rangeValidation.ok) {
      return {
        ok: false,
        reason: "out-of-range",
        tile: currentTile,
        maxDistance: this.options.maxClaimDistanceFromOwned,
        nearestDistance: rangeValidation.nearestDistance,
        playerEnergy: await this.getPlayerEnergy(normalizedUserId),
      };
    }

    const targetLevel = currentTile?.level ?? this.options.initialTileLevel;
    const cost =
      currentTile && currentTile.ownerId && currentTile.ownerId !== normalizedUserId
        ? targetLevel * this.options.hostileClaimCostMultiplier
        : this.options.freeClaimCost;

    const spendAttempt = await this.spendPlayerEnergy(normalizedUserId, cost, now);

    if (!spendAttempt.ok) {
      return {
        ok: false,
        reason: "insufficient-energy",
        tile: currentTile,
        requiredEnergy: cost,
        playerEnergy: spendAttempt.energyAfter,
      };
    }

    const created = currentTile === null;
    const captured = Boolean(currentTile?.ownerId && currentTile.ownerId !== normalizedUserId);
    const claimerProfile = await this.getPlayerProfile(normalizedUserId);

    const nextTile: TileState = currentTile
      ? {
          ...currentTile,
          ownerId: normalizedUserId,
          ownerAllianceTag: claimerProfile.allianceTag,
          ownerAllianceColor: claimerProfile.allianceColor,
          lastUpdate: now,
        }
      : {
          q,
          r,
          ownerId: normalizedUserId,
          ownerAllianceTag: claimerProfile.allianceTag,
          ownerAllianceColor: claimerProfile.allianceColor,
          energy: this.options.initialTileEnergy,
          lastUpdate: now,
          integrity: this.options.initialTileIntegrity,
          level: this.options.initialTileLevel,
          tileType: "normal",
        };

    await this.persistTileState(key, nextTile);
    const member = this.coordMember(q, r);
    await this.redis.sAdd(this.chunkKeyForTile(q, r), member);
    await this.redis.sAdd(TILE_INDEX_KEY, member);
    await this.redis.sAdd(this.ownerTileKey(normalizedUserId), member);

    if (currentTile?.ownerId && currentTile.ownerId !== normalizedUserId) {
      await this.redis.sRem(this.ownerTileKey(currentTile.ownerId), member);
      await this.redis.zIncrBy(LEADERBOARD_TILES_KEY, -1, currentTile.ownerId);
    }

    if (created || (currentTile?.ownerId && currentTile.ownerId !== normalizedUserId) || !currentTile?.ownerId) {
      await this.redis.zIncrBy(LEADERBOARD_TILES_KEY, 1, normalizedUserId);
    }

    if (nextTile.tileType === "nexus") {
      await this.redis.sAdd(POI_INDEX_KEY, this.poiMember(nextTile));
    }

    await this.recordChunkActivity(q, r, captured ? 3 : 1);

    return {
      ok: true,
      created,
      captured,
      tile: nextTile,
      energyAfter: spendAttempt.energyAfter,
      energyCost: cost,
    };
  }

  async repairTile(userId: string, q: number, r: number): Promise<RepairTileResult> {
    const normalizedUserId = this.normalizeUserId(userId);

    this.validateCoordinates(q, r);

    const now = Date.now();
    const key = this.tileKey(q, r);
    const tile = await this.loadTile(q, r);

    if (!tile) {
      return {
        ok: false,
        reason: "tile-not-found",
        message: "tile not found",
        tile: null,
        playerEnergy: await this.getPlayerEnergy(normalizedUserId),
      };
    }

    if (tile.ownerId !== normalizedUserId) {
      return {
        ok: false,
        reason: "not-owner",
        message: "only the owner can repair this tile",
        tile,
        playerEnergy: await this.getPlayerEnergy(normalizedUserId),
      };
    }

    const spendAttempt = await this.spendPlayerEnergy(
      normalizedUserId,
      this.options.repairCostEnergy,
      now,
    );

    if (!spendAttempt.ok) {
      return {
        ok: false,
        reason: "insufficient-energy",
        message: "insufficient energy to repair tile",
        tile,
        requiredEnergy: this.options.repairCostEnergy,
        playerEnergy: spendAttempt.energyAfter,
      };
    }

    const repairedTile: TileState = {
      ...tile,
      integrity: clamp(
        toFixedPrecision(tile.integrity + this.options.repairIntegrityGain),
        0,
        100,
      ),
      lastUpdate: now,
    };

    await this.persistTileState(key, repairedTile);
    await this.recordChunkActivity(q, r, 2);

    return {
      ok: true,
      tile: repairedTile,
      energyAfter: spendAttempt.energyAfter,
      energyCost: this.options.repairCostEnergy,
    };
  }

  async getPlayerEnergy(userId: string): Promise<number> {
    const normalizedUserId = this.normalizeUserId(userId);
    const player = await this.getOrCreatePlayerState(normalizedUserId);
    return player.energy;
  }

  async getPlayerProfile(userId: string): Promise<PlayerProfilePayload> {
    const normalizedUserId = this.normalizeUserId(userId);
    const state = await this.getOrCreatePlayerState(normalizedUserId);

    return {
      userId: state.userId,
      displayName: state.displayName,
      allianceTag: state.allianceTag,
      allianceColor: state.allianceColor,
    };
  }

  async setAllianceTag(userId: string, allianceTag: string | null): Promise<PlayerProfilePayload> {
    const normalizedUserId = this.normalizeUserId(userId);
    const state = await this.getOrCreatePlayerState(normalizedUserId);
    const normalizedTag = this.normalizeAllianceTag(allianceTag);
    const allianceColor = normalizedTag ? this.colorFromAllianceTag(normalizedTag) : null;
    const now = Date.now();

    const nextState: PlayerEnergyState = {
      ...state,
      allianceTag: normalizedTag,
      allianceColor,
      lastUpdate: now,
    };

    await this.persistPlayerState(nextState);
    await this.syncAllianceTagToOwnedTiles(normalizedUserId, normalizedTag, allianceColor);

    return {
      userId: normalizedUserId,
      displayName: nextState.displayName,
      allianceTag: nextState.allianceTag,
      allianceColor: nextState.allianceColor,
    };
  }

  async getLeaderboard(limit = this.options.maxLeaderboardEntries): Promise<LeaderboardEntry[]> {
    const normalizedLimit = clamp(Math.floor(limit), 1, 100);
    const rankedEntries = await this.redis.zRangeWithScores(
      LEADERBOARD_TILES_KEY,
      0,
      normalizedLimit - 1,
      { REV: true },
    );

    const leaderboard: LeaderboardEntry[] = [];

    for (const entry of rankedEntries) {
      const userId = entry.value ?? entry.member;

      if (!userId || userId.trim().length === 0) {
        continue;
      }

      const score = Math.max(0, Math.floor(entry.score));

      if (score <= 0) {
        continue;
      }

      const profile = await this.getPlayerProfile(userId);

      leaderboard.push({
        userId,
        displayName: profile.displayName,
        allianceTag: profile.allianceTag,
        allianceColor: profile.allianceColor,
        score,
      });
    }

    return leaderboard;
  }

  async registerNexus(q: number, r: number, level = 3): Promise<TileState> {
    this.validateCoordinates(q, r);

    if (!Number.isInteger(level) || level <= 0) {
      throw new Error("level must be a positive integer");
    }

    const key = this.tileKey(q, r);
    const existing = await this.loadTile(q, r);
    const now = Date.now();
    const nexusTile: TileState = existing
      ? {
          ...existing,
          level,
          tileType: "nexus",
          lastUpdate: now,
        }
      : {
          q,
          r,
          ownerId: null,
          ownerAllianceTag: null,
          ownerAllianceColor: null,
          energy: this.options.initialTileEnergy,
          lastUpdate: now,
          integrity: this.options.initialTileIntegrity,
          level,
          tileType: "nexus",
        };

    if (existing?.tileType === "nexus") {
      await this.redis.sRem(POI_INDEX_KEY, this.poiMember(existing));
    }

    await this.persistTileState(key, nexusTile);
    const member = this.coordMember(q, r);
    await this.redis.sAdd(this.chunkKeyForTile(q, r), member);
    await this.redis.sAdd(TILE_INDEX_KEY, member);
    await this.redis.sAdd(POI_INDEX_KEY, this.poiMember(nexusTile));

    return nexusTile;
  }

  async get_tiles_in_range(
    centerQ: number,
    centerR: number,
    radius: number,
  ): Promise<TileState[]> {
    this.validateCoordinates(centerQ, centerR);

    if (!Number.isInteger(radius) || radius < 0) {
      throw new Error("radius must be a non-negative integer");
    }

    const center: HexTile = { q: centerQ, r: centerR };
    const chunkKeys = this.chunkKeysForRange(centerQ, centerR, radius);
    const memberGroups = await Promise.all(chunkKeys.map((key) => this.redis.sMembers(key)));

    const uniqueMembers = new Set<string>();

    for (const members of memberGroups) {
      for (const member of members) {
        uniqueMembers.add(member);
      }
    }

    const inRange: HexTile[] = [];

    for (const member of uniqueMembers) {
      const coordinate = this.parseMember(member);

      if (!coordinate) {
        continue;
      }

      if (hex_distance(center, coordinate) <= radius) {
        inRange.push(coordinate);
      }
    }

    const hashes = await Promise.all(
      inRange.map((coordinate) => this.redis.hGetAll(this.tileKey(coordinate.q, coordinate.r))),
    );

    const tiles: TileState[] = [];

    for (let index = 0; index < inRange.length; index += 1) {
      const coordinate = inRange[index];
      const hash = hashes[index];
      const tile = this.parseTile(coordinate.q, coordinate.r, hash);

      if (!tile) {
        continue;
      }

      tiles.push(tile);
    }

    tiles.sort((a, b) => {
      const distanceDiff = hex_distance(center, a) - hex_distance(center, b);

      if (distanceDiff !== 0) {
        return distanceDiff;
      }

      if (a.q !== b.q) {
        return a.q - b.q;
      }

      return a.r - b.r;
    });

    return tiles;
  }

  async get_radar_summary(
    userId: string,
    centerQ: number,
    centerR: number,
    radius: number,
  ): Promise<RadarDataPayload> {
    const normalizedUserId = this.normalizeUserId(userId);
    this.validateCoordinates(centerQ, centerR);

    if (!Number.isInteger(radius) || radius <= 0) {
      throw new Error("radius must be a positive integer");
    }

    const center: HexTile = { q: centerQ, r: centerR };

    const [ownerMembers, poiMembers, chunkActivityHash] = await Promise.all([
      this.redis.sMembers(this.ownerTileKey(normalizedUserId)),
      this.redis.sMembers(POI_INDEX_KEY),
      this.redis.hGetAll(CHUNK_ACTIVITY_KEY),
    ]);

    const playerBases: RadarPlayerBasePoint[] = [];

    for (const member of ownerMembers) {
      const coordinate = this.parseMember(member);

      if (!coordinate) {
        continue;
      }

      if (hex_distance(center, coordinate) > radius) {
        continue;
      }

      playerBases.push({
        q: coordinate.q,
        r: coordinate.r,
        ownerId: normalizedUserId,
      });

      if (playerBases.length >= this.options.maxRadarBasePoints) {
        break;
      }
    }

    const nexusCores: RadarNexusPoint[] = [];

    for (const member of poiMembers) {
      const poi = this.parsePoiMember(member);

      if (!poi || poi.tileType !== "nexus") {
        continue;
      }

      if (hex_distance(center, poi) > radius) {
        continue;
      }

      nexusCores.push({ q: poi.q, r: poi.r, level: poi.level });

      if (nexusCores.length >= this.options.maxRadarNexusPoints) {
        break;
      }
    }

    const hotspots = this.buildRadarHotspots(chunkActivityHash, center, radius);

    return {
      centerQ,
      centerR,
      radius,
      nexusCores,
      playerBases,
      hotspots,
    };
  }

  async rechargeEnergy(now: number = Date.now()): Promise<number> {
    if (!Number.isFinite(now)) {
      throw new Error("now must be finite");
    }

    let updatedTiles = 0;
    const ownerEnergyGains = new Map<string, number>();
    const tileCache = new Map<string, TileState | null>();
    const profileCache = new Map<string, PlayerProfilePayload>();

    const loadTileCached = async (q: number, r: number): Promise<TileState | null> => {
      const key = this.tileKey(q, r);

      if (tileCache.has(key)) {
        return tileCache.get(key) ?? null;
      }

      const hash = await this.redis.hGetAll(key);
      const parsed = this.parseTile(q, r, hash);
      tileCache.set(key, parsed);
      return parsed;
    };

    const loadProfileCached = async (userId: string): Promise<PlayerProfilePayload> => {
      if (profileCache.has(userId)) {
        return profileCache.get(userId) as PlayerProfilePayload;
      }

      const profile = await this.getPlayerProfile(userId);
      profileCache.set(userId, profile);
      return profile;
    };

    await this.scanTileIndex(async (members) => {
      for (const member of members) {
        const coordinate = this.parseMember(member);

        if (!coordinate) {
          continue;
        }

        const key = this.tileKey(coordinate.q, coordinate.r);
        const hash = await this.redis.hGetAll(key);
        const tile = this.parseTile(coordinate.q, coordinate.r, hash);
        tileCache.set(key, tile);

        if (!tile) {
          continue;
        }

        const allianceMultiplier = await this.getAllianceBonusMultiplier(
          tile,
          loadTileCached,
          loadProfileCached,
        );
        const evolved = this.evolveTileState(tile, now, allianceMultiplier);

        if (!this.sameTileState(tile, evolved.tile)) {
          await this.persistTileState(key, evolved.tile);
          tileCache.set(key, evolved.tile);
          updatedTiles += 1;
        }

        if (tile.ownerId && evolved.playerEnergyGenerated > 0) {
          const previous = ownerEnergyGains.get(tile.ownerId) ?? 0;
          ownerEnergyGains.set(tile.ownerId, previous + evolved.playerEnergyGenerated);
        }
      }
    });

    for (const [ownerId, energyGain] of ownerEnergyGains) {
      await this.addPlayerEnergy(ownerId, energyGain, now);
    }

    return updatedTiles;
  }

  startRechargeLoop(): void {
    if (this.rechargeTimer) {
      return;
    }

    this.rechargeTimer = setInterval(() => {
      void this.rechargeEnergy().catch((error) => {
        this.onBackgroundError(error);
      });
    }, this.options.rechargeIntervalMs);
  }

  stopRechargeLoop(): void {
    if (!this.rechargeTimer) {
      return;
    }

    clearInterval(this.rechargeTimer);
    this.rechargeTimer = undefined;
  }

  startSnapshotLoop(): void {
    if (!this.snapshotRepository || this.snapshotTimer) {
      return;
    }

    this.snapshotTimer = setInterval(() => {
      void this.flushSnapshotToPostgres().catch((error) => {
        this.onBackgroundError(error);
      });
    }, this.options.snapshotIntervalMs);
  }

  stopSnapshotLoop(): void {
    if (!this.snapshotTimer) {
      return;
    }

    clearInterval(this.snapshotTimer);
    this.snapshotTimer = undefined;
  }

  async flushSnapshotToPostgres(): Promise<number> {
    const snapshotRepository = this.snapshotRepository;

    if (!snapshotRepository) {
      return 0;
    }

    let persisted = 0;
    let batch: TileState[] = [];

    await this.scanTileIndex(async (members) => {
      const tiles = await this.loadTilesForMembers(members);

      for (const tile of tiles) {
        batch.push(tile);

        if (batch.length >= this.options.snapshotBatchSize) {
          await snapshotRepository.upsertTiles(batch);
          persisted += batch.length;
          batch = [];
        }
      }
    });

    if (batch.length > 0) {
      await snapshotRepository.upsertTiles(batch);
      persisted += batch.length;
    }

    return persisted;
  }

  private async loadTilesForMembers(members: string[]): Promise<TileState[]> {
    const coordinates: HexTile[] = [];

    for (const member of members) {
      const coordinate = this.parseMember(member);

      if (coordinate) {
        coordinates.push(coordinate);
      }
    }

    const hashes = await Promise.all(
      coordinates.map((coordinate) => this.redis.hGetAll(this.tileKey(coordinate.q, coordinate.r))),
    );

    const tiles: TileState[] = [];

    for (let index = 0; index < coordinates.length; index += 1) {
      const coordinate = coordinates[index];
      const hash = hashes[index];
      const tile = this.parseTile(coordinate.q, coordinate.r, hash);

      if (!tile) {
        continue;
      }

      tiles.push(tile);
    }

    return tiles;
  }

  private async scanTileIndex(onBatch: (members: string[]) => Promise<void>): Promise<void> {
    let cursor = "0";

    do {
      const rawResponse = await this.redis.sScan(TILE_INDEX_KEY, cursor, {
        COUNT: this.options.snapshotBatchSize,
      });
      const response = this.normalizeSScanResponse(rawResponse);
      cursor = response.cursor;

      if (response.members.length > 0) {
        await onBatch(response.members);
      }
    } while (cursor !== "0");
  }

  private normalizeSScanResponse(response: SScanResponse): {
    cursor: string;
    members: string[];
  } {
    if (Array.isArray(response)) {
      const [cursor, members] = response;
      return { cursor: String(cursor), members };
    }

    return {
      cursor: String(response.cursor),
      members: response.members,
    };
  }

  private normalizeUserId(userId: string): string {
    const normalized = userId.trim();

    if (normalized.length === 0) {
      throw new Error("userId must not be empty");
    }

    return normalized;
  }

  private normalizeAllianceTag(rawTag: string | null): string | null {
    if (rawTag === null) {
      return null;
    }

    const normalized = rawTag.trim().toUpperCase();

    if (normalized.length === 0) {
      return null;
    }

    if (!/^[A-Z0-9]{3,4}$/.test(normalized)) {
      throw new Error("allianceTag must be 3-4 alphanumeric characters");
    }

    return normalized;
  }

  private async validateClaimDistance(
    userId: string,
    targetQ: number,
    targetR: number,
  ): Promise<{ ok: true } | { ok: false; nearestDistance: number | null }> {
    const ownedMembers = await this.redis.sMembers(this.ownerTileKey(userId));

    if (ownedMembers.length === 0) {
      return { ok: true };
    }

    const target: HexTile = { q: targetQ, r: targetR };
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const member of ownedMembers) {
      const coordinate = this.parseMember(member);

      if (!coordinate) {
        continue;
      }

      const distance = hex_distance(target, coordinate);

      if (distance < nearestDistance) {
        nearestDistance = distance;
      }

      if (distance <= this.options.maxClaimDistanceFromOwned) {
        return { ok: true };
      }
    }

    return {
      ok: false,
      nearestDistance: Number.isFinite(nearestDistance) ? nearestDistance : null,
    };
  }

  private colorFromAllianceTag(allianceTag: string): string {
    let hash = 0;

    for (let index = 0; index < allianceTag.length; index += 1) {
      hash = (hash * 31 + allianceTag.charCodeAt(index)) % 360;
    }

    const hue = hash;
    const saturation = 68;
    const lightness = 56;
    const [r, g, b] = this.hslToRgb(hue / 360, saturation / 100, lightness / 100);

    return `#${[r, g, b]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;
  }

  private hslToRgb(h: number, s: number, l: number): [number, number, number] {
    if (s === 0) {
      const gray = Math.round(l * 255);
      return [gray, gray, gray];
    }

    const hueToRgb = (p: number, q: number, t: number): number => {
      let corrected = t;

      if (corrected < 0) {
        corrected += 1;
      }

      if (corrected > 1) {
        corrected -= 1;
      }

      if (corrected < 1 / 6) {
        return p + (q - p) * 6 * corrected;
      }

      if (corrected < 1 / 2) {
        return q;
      }

      if (corrected < 2 / 3) {
        return p + (q - p) * (2 / 3 - corrected) * 6;
      }

      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;

    const r = hueToRgb(p, q, h + 1 / 3);
    const g = hueToRgb(p, q, h);
    const b = hueToRgb(p, q, h - 1 / 3);

    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  private validateCoordinates(q: number, r: number): void {
    if (!Number.isInteger(q) || !Number.isInteger(r)) {
      throw new Error("q and r must be integer axial coordinates");
    }

    const point = hex_to_pixel(q, r, 1);
    const roundTrip = pixel_to_hex(point.x, point.y, 1);

    if (roundTrip.q !== q || roundTrip.r !== r) {
      throw new Error("q and r are not valid axial coordinates");
    }
  }

  private async loadTile(q: number, r: number): Promise<TileState | null> {
    const key = this.tileKey(q, r);
    const hash = await this.redis.hGetAll(key);
    return this.parseTile(q, r, hash);
  }

  private parseTile(q: number, r: number, hash: Record<string, string>): TileState | null {
    if (!hasValues(hash)) {
      return null;
    }

    const ownerId = hash.ownerId?.trim() ? hash.ownerId : null;
    const ownerAllianceTag = ownerId && hash.ownerAllianceTag?.trim() ? hash.ownerAllianceTag : null;
    const ownerAllianceColor = ownerId && hash.ownerAllianceColor?.trim() ? hash.ownerAllianceColor : null;
    const energy = Number(hash.energy ?? 0);
    const lastUpdate = Number(hash.lastUpdate ?? 0);
    const integrity = Number(hash.integrity ?? this.options.initialTileIntegrity);
    const level = Number(hash.level ?? this.options.initialTileLevel);
    const tileType = hash.tileType === "nexus" ? "nexus" : "normal";

    return {
      q,
      r,
      ownerId,
      ownerAllianceTag,
      ownerAllianceColor,
      energy: Number.isFinite(energy) ? clamp(energy, 0, this.options.maxEnergy) : 0,
      lastUpdate: Number.isFinite(lastUpdate) ? Math.floor(lastUpdate) : 0,
      integrity: Number.isFinite(integrity) ? clamp(integrity, 0, 100) : this.options.initialTileIntegrity,
      level: Number.isFinite(level) ? Math.max(1, Math.floor(level)) : this.options.initialTileLevel,
      tileType,
    };
  }

  private sameTileState(a: TileState, b: TileState): boolean {
    return (
      a.q === b.q &&
      a.r === b.r &&
      a.ownerId === b.ownerId &&
      a.ownerAllianceTag === b.ownerAllianceTag &&
      a.ownerAllianceColor === b.ownerAllianceColor &&
      a.energy === b.energy &&
      a.lastUpdate === b.lastUpdate &&
      a.integrity === b.integrity &&
      a.level === b.level &&
      a.tileType === b.tileType
    );
  }

  private evolveTileState(
    tile: TileState,
    now: number,
    generationMultiplier = 1,
  ): { tile: TileState; playerEnergyGenerated: number } {
    const elapsedMs = Math.max(0, now - tile.lastUpdate);

    if (elapsedMs === 0) {
      return { tile, playerEnergyGenerated: 0 };
    }

    const elapsedSeconds = elapsedMs / 1000;
    const elapsedMinutes = elapsedSeconds / 60;

    const integrityLoss = elapsedMinutes * this.options.integrityDecayPerMinute;
    const nextIntegrity = clamp(toFixedPrecision(tile.integrity - integrityLoss), 0, 100);

    let activeSeconds = 0;

    if (tile.integrity > 0) {
      if (this.options.integrityDecayPerMinute <= 0) {
        activeSeconds = elapsedSeconds;
      } else {
        const secondsUntilZero = (tile.integrity / this.options.integrityDecayPerMinute) * 60;
        activeSeconds = Math.min(elapsedSeconds, Math.max(0, secondsUntilZero));
      }
    }

    const generatedEnergy = activeSeconds * this.options.energyRechargePerSecond * generationMultiplier;
    const nextTileEnergy = clamp(toFixedPrecision(tile.energy + generatedEnergy), 0, this.options.maxEnergy);

    return {
      tile: {
        ...tile,
        integrity: nextIntegrity,
        energy: nextTileEnergy,
        lastUpdate: Math.floor(now),
      },
      playerEnergyGenerated: generatedEnergy,
    };
  }

  private async persistTileState(key: string, tile: TileState): Promise<void> {
    await this.redis.hSet(key, {
      ownerId: tile.ownerId ?? "",
      ownerAllianceTag: tile.ownerAllianceTag ?? "",
      ownerAllianceColor: tile.ownerAllianceColor ?? "",
      energy: toFixedPrecision(tile.energy),
      lastUpdate: Math.floor(tile.lastUpdate),
      integrity: toFixedPrecision(tile.integrity),
      level: Math.max(1, Math.floor(tile.level)),
      tileType: tile.tileType,
    });
  }

  private async getOrCreatePlayerState(userId: string): Promise<PlayerEnergyState> {
    const key = this.playerKey(userId);
    const hash = await this.redis.hGetAll(key);

    if (!hasValues(hash)) {
      const now = Date.now();
      const state: PlayerEnergyState = {
        userId,
        displayName: userId,
        allianceTag: null,
        allianceColor: null,
        energy: this.options.initialPlayerEnergy,
        lastUpdate: now,
      };

      await this.persistPlayerState(state);
      return state;
    }

    const energy = Number(hash.energy ?? this.options.initialPlayerEnergy);
    const lastUpdate = Number(hash.lastUpdate ?? Date.now());
    const displayName = hash.displayName?.trim() || userId;
    const allianceTag = hash.allianceTag?.trim() ? hash.allianceTag : null;
    const allianceColor = hash.allianceColor?.trim() ? hash.allianceColor : null;

    return {
      userId,
      displayName,
      allianceTag,
      allianceColor,
      energy: Number.isFinite(energy) ? clamp(energy, 0, this.options.maxPlayerEnergy) : 0,
      lastUpdate: Number.isFinite(lastUpdate) ? Math.floor(lastUpdate) : Date.now(),
    };
  }

  private async persistPlayerState(state: PlayerEnergyState): Promise<void> {
    await this.redis.hSet(this.playerKey(state.userId), {
      displayName: state.displayName,
      allianceTag: state.allianceTag ?? "",
      allianceColor: state.allianceColor ?? "",
      energy: toFixedPrecision(state.energy),
      lastUpdate: Math.floor(state.lastUpdate),
    });
  }

  private async spendPlayerEnergy(
    userId: string,
    cost: number,
    now: number,
  ): Promise<{ ok: true; energyAfter: number } | { ok: false; energyAfter: number }> {
    if (cost <= 0) {
      return { ok: true, energyAfter: await this.getPlayerEnergy(userId) };
    }

    const state = await this.getOrCreatePlayerState(userId);

    if (state.energy < cost) {
      return { ok: false, energyAfter: toFixedPrecision(state.energy) };
    }

    const nextEnergy = clamp(toFixedPrecision(state.energy - cost), 0, this.options.maxPlayerEnergy);

    await this.persistPlayerState({
      ...state,
      energy: nextEnergy,
      lastUpdate: now,
    });

    return { ok: true, energyAfter: nextEnergy };
  }

  private async addPlayerEnergy(userId: string, gain: number, now: number): Promise<number> {
    if (gain <= 0) {
      return this.getPlayerEnergy(userId);
    }

    const state = await this.getOrCreatePlayerState(userId);
    const nextEnergy = clamp(toFixedPrecision(state.energy + gain), 0, this.options.maxPlayerEnergy);

    await this.persistPlayerState({
      ...state,
      energy: nextEnergy,
      lastUpdate: now,
    });

    return nextEnergy;
  }

  private async syncAllianceTagToOwnedTiles(
    userId: string,
    allianceTag: string | null,
    allianceColor: string | null,
  ): Promise<void> {
    const members = await this.redis.sMembers(this.ownerTileKey(userId));

    for (const member of members) {
      const coordinate = this.parseMember(member);

      if (!coordinate) {
        continue;
      }

      await this.redis.hSet(this.tileKey(coordinate.q, coordinate.r), {
        ownerAllianceTag: allianceTag ?? "",
        ownerAllianceColor: allianceColor ?? "",
      });
    }
  }

  private async getAllianceBonusMultiplier(
    tile: TileState,
    loadTile: (q: number, r: number) => Promise<TileState | null>,
    loadProfile: (userId: string) => Promise<PlayerProfilePayload>,
  ): Promise<number> {
    if (!tile.ownerId) {
      return 1;
    }

    const ownerProfile = await loadProfile(tile.ownerId);

    if (!ownerProfile.allianceTag) {
      return 1;
    }

    const neighbors = get_neighbors(tile.q, tile.r);

    for (const neighbor of neighbors) {
      const neighborTile = await loadTile(neighbor.q, neighbor.r);

      if (!neighborTile?.ownerId || neighborTile.ownerId === tile.ownerId) {
        continue;
      }

      const neighborProfile = await loadProfile(neighborTile.ownerId);

      if (neighborProfile.allianceTag === ownerProfile.allianceTag) {
        return this.options.allianceNeighborBonusMultiplier;
      }
    }

    return 1;
  }

  private buildRadarHotspots(
    chunkActivityHash: Record<string, string>,
    center: HexTile,
    radius: number,
  ): RadarHotspotPoint[] {
    const hotspots: RadarHotspotPoint[] = [];

    for (const [field, rawActivity] of Object.entries(chunkActivityHash)) {
      const activity = Number(rawActivity);

      if (!Number.isFinite(activity) || activity <= 0) {
        continue;
      }

      const chunk = this.parseChunkField(field);

      if (!chunk) {
        continue;
      }

      const approxQ = chunk.chunkQ * this.options.chunkSize + Math.floor(this.options.chunkSize / 2);
      const approxR = chunk.chunkR * this.options.chunkSize + Math.floor(this.options.chunkSize / 2);

      if (hex_distance(center, { q: approxQ, r: approxR }) > radius + this.options.chunkSize) {
        continue;
      }

      hotspots.push({
        q: approxQ,
        r: approxR,
        activity,
      });
    }

    hotspots.sort((a, b) => b.activity - a.activity);

    return hotspots.slice(0, this.options.maxRadarHotspots);
  }

  private async recordChunkActivity(q: number, r: number, amount: number): Promise<void> {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }

    const chunkField = `${this.toChunkIndex(q)}:${this.toChunkIndex(r)}`;
    await this.redis.hIncrBy(CHUNK_ACTIVITY_KEY, chunkField, Math.floor(amount));
  }

  private parseChunkField(field: string): { chunkQ: number; chunkR: number } | null {
    const parts = field.split(":");

    if (parts.length !== 2) {
      return null;
    }

    const chunkQ = Number(parts[0]);
    const chunkR = Number(parts[1]);

    if (!Number.isInteger(chunkQ) || !Number.isInteger(chunkR)) {
      return null;
    }

    return { chunkQ, chunkR };
  }

  private parsePoiMember(
    member: string,
  ): (HexTile & { tileType: TileType; level: number }) | null {
    const parts = member.split(":");

    if (parts.length < 3) {
      return null;
    }

    const tileType = parts[0] === "nexus" ? "nexus" : "normal";
    const q = Number(parts[1]);
    const r = Number(parts[2]);
    const level = Number(parts[3] ?? 1);

    if (!Number.isInteger(q) || !Number.isInteger(r)) {
      return null;
    }

    return {
      q,
      r,
      tileType,
      level: Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1,
    };
  }

  private poiMember(tile: Pick<TileState, "q" | "r" | "tileType" | "level">): string {
    return `${tile.tileType}:${tile.q}:${tile.r}:${Math.max(1, Math.floor(tile.level))}`;
  }

  private parseMember(member: string): HexTile | null {
    const parts = member.split(":");

    if (parts.length !== 2) {
      return null;
    }

    const q = Number(parts[0]);
    const r = Number(parts[1]);

    if (!Number.isInteger(q) || !Number.isInteger(r)) {
      return null;
    }

    return { q, r };
  }

  private coordMember(q: number, r: number): string {
    return `${q}:${r}`;
  }

  private tileKey(q: number, r: number): string {
    return `tile:${q}:${r}`;
  }

  private playerKey(userId: string): string {
    return `player:${userId}:state`;
  }

  private ownerTileKey(userId: string): string {
    return `owner:${userId}:tiles`;
  }

  private chunkKey(chunkQ: number, chunkR: number): string {
    return `chunk:${chunkQ}:${chunkR}:tiles`;
  }

  private chunkKeyForTile(q: number, r: number): string {
    return this.chunkKey(this.toChunkIndex(q), this.toChunkIndex(r));
  }

  private chunkKeysForRange(centerQ: number, centerR: number, radius: number): string[] {
    const minQ = centerQ - radius;
    const maxQ = centerQ + radius;
    const minR = centerR - radius;
    const maxR = centerR + radius;

    const keys: string[] = [];

    for (let chunkQ = this.toChunkIndex(minQ); chunkQ <= this.toChunkIndex(maxQ); chunkQ += 1) {
      for (
        let chunkR = this.toChunkIndex(minR);
        chunkR <= this.toChunkIndex(maxR);
        chunkR += 1
      ) {
        keys.push(this.chunkKey(chunkQ, chunkR));
      }
    }

    return keys;
  }

  private toChunkIndex(value: number): number {
    return Math.floor(value / this.options.chunkSize);
  }
}
