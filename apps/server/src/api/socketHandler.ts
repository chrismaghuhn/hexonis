import {
  SOCKET_EVENT,
  type ClaimTilePayload,
  type ClientToServerEvents,
  type EnergyUpdatePayload,
  type GetLeaderboardPayload,
  type InterServerEvents,
  type RadarRequestPayload,
  type RepairTilePayload,
  type SetAllianceTagPayload,
  type ServerToClientEvents,
  type SyncViewPayload,
} from "@hexonis/shared/events";
import type { Server, Socket } from "socket.io";

import type { TileManager } from "../game/TileManager";
import { attachActionRateLimiter } from "./rateLimiter";

export interface SocketSessionData {
  userId: string;
  chunkIds: Set<string>;
}

export interface SocketLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface RegisterSocketHandlerOptions {
  chunkSize: number;
  logger?: SocketLogger;
  energyUpdateIntervalMs?: number;
}

const DEFAULT_LOGGER: SocketLogger = {
  info: (message, context) => {
    console.info(message, context ?? {});
  },
  warn: (message, context) => {
    console.warn(message, context ?? {});
  },
  error: (message, context) => {
    console.error(message, context ?? {});
  },
};

function chunkIndex(value: number, chunkSize: number): number {
  return Math.floor(value / chunkSize);
}

export function chunkIdForTile(q: number, r: number, chunkSize: number): string {
  return `chunk:${chunkIndex(q, chunkSize)}:${chunkIndex(r, chunkSize)}`;
}

function chunkIdsForView(
  centerQ: number,
  centerR: number,
  radius: number,
  chunkSize: number,
): string[] {
  const minQ = centerQ - radius;
  const maxQ = centerQ + radius;
  const minR = centerR - radius;
  const maxR = centerR + radius;
  const chunkIds: string[] = [];

  for (let chunkQ = chunkIndex(minQ, chunkSize); chunkQ <= chunkIndex(maxQ, chunkSize); chunkQ += 1) {
    for (
      let chunkR = chunkIndex(minR, chunkSize);
      chunkR <= chunkIndex(maxR, chunkSize);
      chunkR += 1
    ) {
      chunkIds.push(`chunk:${chunkQ}:${chunkR}`);
    }
  }

  return chunkIds;
}

function parseInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }

  return value;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "unknown error";
}

async function syncChunkRooms(
  socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketSessionData>,
  nextChunkIds: string[],
): Promise<string[]> {
  const currentChunkIds = socket.data.chunkIds ?? new Set<string>();
  const nextChunkSet = new Set(nextChunkIds);

  for (const roomId of currentChunkIds) {
    if (!nextChunkSet.has(roomId)) {
      await socket.leave(roomId);
    }
  }

  for (const roomId of nextChunkSet) {
    if (!currentChunkIds.has(roomId)) {
      await socket.join(roomId);
    }
  }

  socket.data.chunkIds = nextChunkSet;
  return [...nextChunkSet.values()];
}

export function registerSocketHandler(
  io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketSessionData>,
  tileManager: TileManager,
  options: RegisterSocketHandlerOptions,
): void {
  const logger = options.logger ?? DEFAULT_LOGGER;
  const energyUpdateIntervalMs = options.energyUpdateIntervalMs ?? 1000;

  if (!Number.isInteger(options.chunkSize) || options.chunkSize <= 0) {
    throw new Error("chunkSize must be a positive integer");
  }

  io.use((socket, next) => {
    const userIdCandidate =
      socket.handshake.auth.userId ??
      (typeof socket.handshake.query.userId === "string"
        ? socket.handshake.query.userId
        : undefined);

    if (typeof userIdCandidate !== "string" || userIdCandidate.trim().length === 0) {
      next(new Error("userId is required in socket handshake"));
      return;
    }

    socket.data.userId = userIdCandidate.trim();
    socket.data.chunkIds = new Set<string>();
    next();
  });

  io.on("connection", (socket) => {
    attachActionRateLimiter(socket, {
      claimTileMs: 500,
      repairTileMs: 200,
      getRadarDataMs: 2_000,
      message: "Too many actions. Slow down!",
    });

    logger.info("socket connected", {
      socketId: socket.id,
      userId: socket.data.userId,
    });

    const emitEnergyUpdate = async (): Promise<void> => {
      const energy = await tileManager.getPlayerEnergy(socket.data.userId);
      const payload: EnergyUpdatePayload = {
        userId: socket.data.userId,
        energy,
      };
      socket.emit(SOCKET_EVENT.ENERGY_UPDATE, payload);
    };

    const emitProfileUpdate = async (): Promise<void> => {
      const profile = await tileManager.getPlayerProfile(socket.data.userId);
      socket.emit(SOCKET_EVENT.PROFILE_UPDATE, profile);
    };

    const emitLeaderboardUpdate = async (limit = 10): Promise<void> => {
      const entries = await tileManager.getLeaderboard(limit);
      socket.emit(SOCKET_EVENT.LEADERBOARD_UPDATE, {
        entries,
        updatedAt: Date.now(),
      });
    };

    const broadcastLeaderboardUpdate = async (limit = 10): Promise<void> => {
      const entries = await tileManager.getLeaderboard(limit);
      io.emit(SOCKET_EVENT.LEADERBOARD_UPDATE, {
        entries,
        updatedAt: Date.now(),
      });
    };

    void emitEnergyUpdate().catch((error) => {
      logger.warn("initial energy_update failed", {
        socketId: socket.id,
        userId: socket.data.userId,
        message: normalizeError(error),
      });
    });

    void emitProfileUpdate().catch((error) => {
      logger.warn("initial profile_update failed", {
        socketId: socket.id,
        userId: socket.data.userId,
        message: normalizeError(error),
      });
    });

    void emitLeaderboardUpdate().catch((error) => {
      logger.warn("initial leaderboard_update failed", {
        socketId: socket.id,
        userId: socket.data.userId,
        message: normalizeError(error),
      });
    });

    const energyTimer = setInterval(() => {
      void emitEnergyUpdate().catch((error) => {
        logger.warn("periodic energy_update failed", {
          socketId: socket.id,
          userId: socket.data.userId,
          message: normalizeError(error),
        });
      });
    }, energyUpdateIntervalMs);

    socket.on(SOCKET_EVENT.SYNC_VIEW, async (payload, acknowledge) => {
      try {
        const unsafePayload = payload as Partial<SyncViewPayload> | undefined;
        const centerQ = parseInteger("centerQ", unsafePayload?.centerQ);
        const centerR = parseInteger("centerR", unsafePayload?.centerR);
        const radius = parseInteger("radius", unsafePayload?.radius);

        if (radius < 0) {
          throw new Error("radius must be >= 0");
        }

        const tiles = await tileManager.get_tiles_in_range(centerQ, centerR, radius);
        const chunkIds = await syncChunkRooms(
          socket,
          chunkIdsForView(centerQ, centerR, radius, options.chunkSize),
        );

        socket.emit(SOCKET_EVENT.VIEW_UPDATE, {
          centerQ,
          centerR,
          radius,
          chunkIds,
          tiles,
        });

        acknowledge?.({
          ok: true,
          chunkIds,
          tileCount: tiles.length,
        });

        void emitEnergyUpdate();
      } catch (error) {
        const message = normalizeError(error);

        logger.warn("sync_view failed", {
          socketId: socket.id,
          userId: socket.data.userId,
          message,
        });

        socket.emit(SOCKET_EVENT.REQUEST_ERROR, {
          event: SOCKET_EVENT.SYNC_VIEW,
          message,
        });

        acknowledge?.({ ok: false, message });
      }
    });

    socket.on(SOCKET_EVENT.GET_RADAR_DATA, async (payload, acknowledge) => {
      try {
        const unsafePayload = payload as Partial<RadarRequestPayload> | undefined;
        const centerQ = parseInteger("centerQ", unsafePayload?.centerQ);
        const centerR = parseInteger("centerR", unsafePayload?.centerR);
        const radius = parseInteger("radius", unsafePayload?.radius);

        if (radius <= 0) {
          throw new Error("radius must be > 0");
        }

        const summary = await tileManager.get_radar_summary(
          socket.data.userId,
          centerQ,
          centerR,
          radius,
        );

        socket.emit(SOCKET_EVENT.RADAR_DATA, summary);

        acknowledge?.({
          ok: true,
          nexusCount: summary.nexusCores.length,
          baseCount: summary.playerBases.length,
          hotspotCount: summary.hotspots.length,
        });
      } catch (error) {
        const message = normalizeError(error);

        logger.warn("get_radar_data failed", {
          socketId: socket.id,
          userId: socket.data.userId,
          message,
        });

        socket.emit(SOCKET_EVENT.REQUEST_ERROR, {
          event: SOCKET_EVENT.GET_RADAR_DATA,
          message,
        });

        acknowledge?.({ ok: false, message });
      }
    });

    socket.on(SOCKET_EVENT.GET_LEADERBOARD, async (payload, acknowledge) => {
      try {
        const unsafePayload = payload as Partial<GetLeaderboardPayload> | undefined;
        const requestedLimit = unsafePayload?.limit;
        const limit =
          typeof requestedLimit === "number" && Number.isInteger(requestedLimit)
            ? Math.max(1, Math.min(100, requestedLimit))
            : 10;
        const entries = await tileManager.getLeaderboard(limit);

        socket.emit(SOCKET_EVENT.LEADERBOARD_UPDATE, {
          entries,
          updatedAt: Date.now(),
        });

        acknowledge?.({
          ok: true,
          count: entries.length,
        });
      } catch (error) {
        const message = normalizeError(error);

        logger.warn("get_leaderboard failed", {
          socketId: socket.id,
          userId: socket.data.userId,
          message,
        });

        socket.emit(SOCKET_EVENT.REQUEST_ERROR, {
          event: SOCKET_EVENT.GET_LEADERBOARD,
          message,
        });

        acknowledge?.({ ok: false, message });
      }
    });

    socket.on(SOCKET_EVENT.SET_ALLIANCE_TAG, async (payload, acknowledge) => {
      try {
        const unsafePayload = payload as Partial<SetAllianceTagPayload> | undefined;
        const rawTag = unsafePayload?.allianceTag;

        if (rawTag !== undefined && rawTag !== null && typeof rawTag !== "string") {
          throw new Error("allianceTag must be a string or null");
        }

        const profile = await tileManager.setAllianceTag(socket.data.userId, rawTag ?? null);

        socket.emit(SOCKET_EVENT.PROFILE_UPDATE, profile);
        await broadcastLeaderboardUpdate();

        acknowledge?.({
          ok: true,
          profile,
        });
      } catch (error) {
        const message = normalizeError(error);

        logger.warn("set_alliance_tag failed", {
          socketId: socket.id,
          userId: socket.data.userId,
          message,
        });

        socket.emit(SOCKET_EVENT.REQUEST_ERROR, {
          event: SOCKET_EVENT.SET_ALLIANCE_TAG,
          message,
        });

        acknowledge?.({ ok: false, message });
      }
    });

    socket.on(SOCKET_EVENT.CLAIM_TILE, async (payload, acknowledge) => {
      try {
        const unsafePayload = payload as Partial<ClaimTilePayload> | undefined;
        const q = parseInteger("q", unsafePayload?.q);
        const r = parseInteger("r", unsafePayload?.r);
        const claim = await tileManager.claimTile(socket.data.userId, q, r);

        if (!claim.ok) {
          let message = "tile already claimed";

          if (claim.reason === "insufficient-energy") {
            message = "insufficient energy for claim";
          } else if (claim.reason === "out-of-range") {
            message = "claim is too far from your territory";
          }

          acknowledge?.({
            ok: false,
            message,
            reason: claim.reason,
            tile: claim.tile,
            requiredEnergy: "requiredEnergy" in claim ? claim.requiredEnergy : undefined,
            maxDistance: "maxDistance" in claim ? claim.maxDistance : undefined,
            nearestDistance: "nearestDistance" in claim ? claim.nearestDistance : undefined,
            playerEnergy: claim.playerEnergy,
          });

          socket.emit(SOCKET_EVENT.ENERGY_UPDATE, {
            userId: socket.data.userId,
            energy: claim.playerEnergy,
          });
          return;
        }

        const chunkId = chunkIdForTile(q, r, options.chunkSize);

        io.to(chunkId).emit(SOCKET_EVENT.TILE_CLAIMED, {
          chunkId,
          tile: claim.tile,
          claimedByUserId: socket.data.userId,
          created: claim.created,
          captured: claim.captured,
          energyCost: claim.energyCost,
        });

        void broadcastLeaderboardUpdate().catch((error) => {
          logger.warn("leaderboard_update broadcast failed", {
            socketId: socket.id,
            userId: socket.data.userId,
            message: normalizeError(error),
          });
        });

        socket.emit(SOCKET_EVENT.ENERGY_UPDATE, {
          userId: socket.data.userId,
          energy: claim.energyAfter,
        });

        acknowledge?.({
          ok: true,
          created: claim.created,
          captured: claim.captured,
          tile: claim.tile,
          energyAfter: claim.energyAfter,
          energyCost: claim.energyCost,
        });
      } catch (error) {
        const message = normalizeError(error);

        logger.warn("claim_tile failed", {
          socketId: socket.id,
          userId: socket.data.userId,
          message,
        });

        socket.emit(SOCKET_EVENT.REQUEST_ERROR, {
          event: SOCKET_EVENT.CLAIM_TILE,
          message,
        });

        acknowledge?.({ ok: false, message });
      }
    });

    socket.on(SOCKET_EVENT.REPAIR_TILE, async (payload, acknowledge) => {
      try {
        const unsafePayload = payload as Partial<RepairTilePayload> | undefined;
        const q = parseInteger("q", unsafePayload?.q);
        const r = parseInteger("r", unsafePayload?.r);
        const repair = await tileManager.repairTile(socket.data.userId, q, r);

        if (!repair.ok) {
          acknowledge?.({
            ok: false,
            message: repair.message,
            reason: repair.reason,
            tile: repair.tile,
            requiredEnergy: repair.requiredEnergy,
            playerEnergy: repair.playerEnergy,
          });

          socket.emit(SOCKET_EVENT.ENERGY_UPDATE, {
            userId: socket.data.userId,
            energy: repair.playerEnergy,
          });
          return;
        }

        const chunkId = chunkIdForTile(q, r, options.chunkSize);

        io.to(chunkId).emit(SOCKET_EVENT.TILE_REPAIRED, {
          chunkId,
          tile: repair.tile,
          repairedByUserId: socket.data.userId,
          energyCost: repair.energyCost,
        });

        socket.emit(SOCKET_EVENT.ENERGY_UPDATE, {
          userId: socket.data.userId,
          energy: repair.energyAfter,
        });

        acknowledge?.({
          ok: true,
          tile: repair.tile,
          energyAfter: repair.energyAfter,
          energyCost: repair.energyCost,
        });
      } catch (error) {
        const message = normalizeError(error);

        logger.warn("repair_tile failed", {
          socketId: socket.id,
          userId: socket.data.userId,
          message,
        });

        socket.emit(SOCKET_EVENT.REQUEST_ERROR, {
          event: SOCKET_EVENT.REPAIR_TILE,
          message,
        });

        acknowledge?.({ ok: false, message });
      }
    });

    socket.on("disconnect", (reason) => {
      clearInterval(energyTimer);
      socket.data.chunkIds = new Set<string>();

      logger.info("socket disconnected", {
        socketId: socket.id,
        userId: socket.data.userId,
        reason,
      });
    });
  });
}
