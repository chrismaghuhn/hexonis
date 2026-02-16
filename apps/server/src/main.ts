import { createServer, type Server as HttpServer } from "node:http";

import {
  type ClientToServerEvents,
  type InterServerEvents,
  type ServerToClientEvents,
} from "@hexonis/shared/events";
import express from "express";
import { Pool } from "pg";
import { createClient } from "redis";
import { Server } from "socket.io";

import {
  registerSocketHandler,
  type SocketLogger,
  type SocketSessionData,
} from "./api/socketHandler";
import { PostgresTileSnapshotRepository } from "./db/PostgresTileSnapshotRepository";
import { TileManager, type RedisTileStore } from "./game/TileManager";

type AppRedisClient = ReturnType<typeof createClient>;

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];

  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }

  return parsed;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

function parseNexusSeed(value: string): Array<{ q: number; r: number; level: number }> {
  try {
    const normalized = value.trim();

    if (normalized.length === 0) {
      return [];
    }

    if (normalized.startsWith("[")) {
      const parsedJson = JSON.parse(normalized) as Array<{
        q?: unknown;
        r?: unknown;
        level?: unknown;
      }>;

      if (!Array.isArray(parsedJson)) {
        throw new Error("NEXUS_COORDS JSON must be an array");
      }

      return parsedJson.map((entry, index) => {
        const q = Number(entry.q);
        const r = Number(entry.r);
        const level = entry.level === undefined ? 3 : Number(entry.level);

        if (!Number.isInteger(q) || !Number.isInteger(r) || !Number.isInteger(level) || level <= 0) {
          throw new Error(`invalid NEXUS_COORDS JSON entry at index ${index}`);
        }

        return { q, r, level };
      });
    }

    return normalized
      .split(/[;,]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const [qRaw, rRaw, levelRaw] = entry.split(":");
        const q = Number(qRaw);
        const r = Number(rRaw);
        const level = levelRaw ? Number(levelRaw) : 3;

        if (!Number.isInteger(q) || !Number.isInteger(r) || !Number.isInteger(level) || level <= 0) {
          throw new Error(`invalid NEXUS_COORDS entry '${entry}'`);
        }

        return { q, r, level };
      });
  } catch (error) {
    console.error("Failed to parse NEXUS_COORDS, using empty array", {
      error: normalizeError(error),
    });

    return [];
  }
}

function createLogger(): SocketLogger {
  const log = (
    level: "info" | "warn" | "error",
    message: string,
    context?: Record<string, unknown>,
  ): void => {
    const timestamp = new Date().toISOString();
    const payload = context && Object.keys(context).length > 0 ? context : undefined;

    if (payload) {
      console[level](`[${timestamp}] ${message}`, payload);
      return;
    }

    console[level](`[${timestamp}] ${message}`);
  };

  return {
    info: (message, context) => {
      log("info", message, context);
    },
    warn: (message, context) => {
      log("warn", message, context);
    },
    error: (message, context) => {
      log("error", message, context);
    },
  };
}

function createRedisTileStore(redisClient: AppRedisClient): RedisTileStore {
  return {
    hGetAll: (key) => redisClient.hGetAll(key),
    hSet: (key, values) => redisClient.hSet(key, values),
    hIncrBy: (key, field, increment) => redisClient.hIncrBy(key, field, increment),
    hSetNX: (key, field, value) => redisClient.hSetNX(key, field, value),
    zIncrBy: (key, increment, member) => redisClient.zIncrBy(key, increment, member),
    zRangeWithScores: (key, min, max, options) => redisClient.zRangeWithScores(key, min, max, options),
    sAdd: (key, ...members) => redisClient.sAdd(key, members),
    sRem: (key, ...members) => redisClient.sRem(key, members),
    sMembers: (key) => redisClient.sMembers(key),
    sScan: (key, cursor, options) => redisClient.sScan(key, cursor, options),
  };
}

async function closeHttpServer(httpServer: HttpServer): Promise<void> {
  if (!httpServer.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function startServer(): Promise<void> {
  const logger = createLogger();
  const host = process.env.HOST ?? "0.0.0.0";
  const port = positiveInteger(numberFromEnv("PORT", 3001), "PORT");
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const postgresUrl =
    process.env.POSTGRES_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/hexonis";
  const socketCorsOrigin = process.env.SOCKET_CORS_ORIGIN ?? "*";
  const chunkSize = positiveInteger(numberFromEnv("CHUNK_SIZE", 64), "CHUNK_SIZE");
  const maxEnergy = numberFromEnv("MAX_ENERGY", 100);
  const initialTileEnergy = numberFromEnv("INITIAL_TILE_ENERGY", 100);
  const initialTileIntegrity = numberFromEnv("INITIAL_TILE_INTEGRITY", 100);
  const maxClaimDistanceFromOwned = positiveInteger(
    numberFromEnv("CLAIM_MAX_DISTANCE", 8),
    "CLAIM_MAX_DISTANCE",
  );
  const energyRechargePerSecond = numberFromEnv("ENERGY_RECHARGE_PER_SECOND", 1);
  const rechargeIntervalMs = positiveInteger(
    numberFromEnv("RECHARGE_INTERVAL_MS", 1000),
    "RECHARGE_INTERVAL_MS",
  );
  const snapshotIntervalMs = positiveInteger(
    numberFromEnv("SNAPSHOT_INTERVAL_MS", 5 * 60 * 1000),
    "SNAPSHOT_INTERVAL_MS",
  );
  const snapshotBatchSize = positiveInteger(
    numberFromEnv("SNAPSHOT_BATCH_SIZE", 1000),
    "SNAPSHOT_BATCH_SIZE",
  );

  const redisClient = createClient({ url: redisUrl });
  const postgresPool = new Pool({ connectionString: postgresUrl });
  const app = express();

  let isShuttingDownForRedisError = false;

  redisClient.on("error", (error) => {
    logger.error("Redis connection failed. Shutting down server.", {
      error: normalizeError(error),
    });

    if (!isShuttingDownForRedisError) {
      isShuttingDownForRedisError = true;
      process.exit(1);
    }
  });

  try {
    await redisClient.connect();
  } catch (error) {
    logger.error("Could not connect to Redis. Server startup aborted.", {
      redisUrl,
      error: normalizeError(error),
    });
    throw error;
  }

  try {
    await postgresPool.query("SELECT 1");
  } catch (error) {
    logger.error("Could not connect to PostgreSQL. Server startup aborted.", {
      postgresUrl,
      error: normalizeError(error),
    });

    if (redisClient.isOpen) {
      await redisClient.quit();
    }

    throw error;
  }

  const snapshotRepository = new PostgresTileSnapshotRepository(postgresPool);
  await snapshotRepository.ensureSchema();

  const tileManager = new TileManager({
    redis: createRedisTileStore(redisClient),
    snapshotRepository,
    options: {
      chunkSize,
      maxEnergy,
      initialTileEnergy,
      initialTileIntegrity,
      maxClaimDistanceFromOwned,
      energyRechargePerSecond,
      rechargeIntervalMs,
      snapshotIntervalMs,
      snapshotBatchSize,
    },
    onBackgroundError: (error) => {
      logger.error("Snapshot flush failed", {
        error: normalizeError(error),
      });
    },
  });

  const nexusSeedRaw = process.env.NEXUS_COORDS;

  if (nexusSeedRaw && nexusSeedRaw.trim().length > 0) {
    const nexusSeed = parseNexusSeed(nexusSeedRaw);

    for (const nexus of nexusSeed) {
      await tileManager.registerNexus(nexus.q, nexus.r, nexus.level);
    }

    logger.info("Nexus cores seeded", { count: nexusSeed.length });
  }

  tileManager.startSnapshotLoop();
  tileManager.startRechargeLoop();

  app.use(express.json());
  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  const httpServer = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketSessionData>(
    httpServer,
    {
      cors: {
        origin: socketCorsOrigin,
      },
    },
  );

  registerSocketHandler(io, tileManager, {
    chunkSize,
    logger,
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => resolve());
  });

  logger.info("Hexonis realtime server started", {
    host,
    port,
    chunkSize,
    socketCorsOrigin,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("Shutdown signal received", { signal });

    tileManager.stopSnapshotLoop();
    tileManager.stopRechargeLoop();

    await new Promise<void>((resolve) => {
      io.close(() => resolve());
    });

    await closeHttpServer(httpServer);

    if (redisClient.isOpen) {
      await redisClient.quit();
    }

    await postgresPool.end();
    logger.info("Server shutdown complete");
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void startServer().catch((error) => {
  console.error(`[${new Date().toISOString()}] Bootstrap failed`, {
    error: normalizeError(error),
  });
  process.exit(1);
});
