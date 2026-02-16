import {
  SOCKET_EVENT,
  type ClientToServerEvents,
  type InterServerEvents,
  type RequestErrorPayload,
  type ServerToClientEvents,
} from "@hexonis/shared/events";
import type { Socket } from "socket.io";

type RateLimitedEvent =
  | typeof SOCKET_EVENT.CLAIM_TILE
  | typeof SOCKET_EVENT.REPAIR_TILE
  | typeof SOCKET_EVENT.GET_RADAR_DATA;

interface RateLimitStore {
  get(key: string): number | undefined;
  set(key: string, value: number): void;
  sweep?(now: number): void;
}

class InMemoryRateLimitStore implements RateLimitStore {
  private readonly store = new Map<string, number>();
  private lastSweepAt = 0;

  constructor(private readonly ttlMs: number) {}

  get(key: string): number | undefined {
    return this.store.get(key);
  }

  set(key: string, value: number): void {
    this.store.set(key, value);
  }

  sweep(now: number): void {
    if (now - this.lastSweepAt < 60_000) {
      return;
    }

    this.lastSweepAt = now;

    for (const [key, timestamp] of this.store) {
      if (now - timestamp > this.ttlMs) {
        this.store.delete(key);
      }
    }
  }
}

export interface ActionRateLimiterConfig {
  claimTileMs?: number;
  repairTileMs?: number;
  getRadarDataMs?: number;
  message?: string;
  now?: () => number;
  store?: RateLimitStore;
}

const DEFAULT_CONFIG = {
  claimTileMs: 500,
  repairTileMs: 200,
  getRadarDataMs: 2_000,
  message: "Too many actions. Slow down!",
} as const;

function cooldownForEvent(event: string, config: Required<ActionRateLimiterConfig>): number | null {
  switch (event) {
    case SOCKET_EVENT.CLAIM_TILE:
      return config.claimTileMs;
    case SOCKET_EVENT.REPAIR_TILE:
      return config.repairTileMs;
    case SOCKET_EVENT.GET_RADAR_DATA:
      return config.getRadarDataMs;
    default:
      return null;
  }
}

export function attachActionRateLimiter(
  socket: Socket<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    { userId: string; chunkIds: Set<string> }
  >,
  config: ActionRateLimiterConfig = {},
): void {
  const resolved: Required<ActionRateLimiterConfig> = {
    claimTileMs: config.claimTileMs ?? DEFAULT_CONFIG.claimTileMs,
    repairTileMs: config.repairTileMs ?? DEFAULT_CONFIG.repairTileMs,
    getRadarDataMs: config.getRadarDataMs ?? DEFAULT_CONFIG.getRadarDataMs,
    message: config.message ?? DEFAULT_CONFIG.message,
    now: config.now ?? Date.now,
    store:
      config.store ??
      new InMemoryRateLimitStore(
        Math.max(
          DEFAULT_CONFIG.getRadarDataMs,
          config.claimTileMs ?? DEFAULT_CONFIG.claimTileMs,
          config.repairTileMs ?? DEFAULT_CONFIG.repairTileMs,
          config.getRadarDataMs ?? DEFAULT_CONFIG.getRadarDataMs,
        ) * 20,
      ),
  };

  socket.use((packet, next) => {
    const event = typeof packet[0] === "string" ? packet[0] : "";
    const cooldownMs = cooldownForEvent(event, resolved);

    if (cooldownMs === null) {
      next();
      return;
    }

    const userId = socket.data.userId;

    if (!userId) {
      next();
      return;
    }

    const now = resolved.now();
    resolved.store.sweep?.(now);

    const rateKey = `${userId}:${event}`;
    const lastActionAt = resolved.store.get(rateKey);

    if (lastActionAt !== undefined && now - lastActionAt < cooldownMs) {
      const payload: RequestErrorPayload = {
        event: event as RateLimitedEvent,
        message: resolved.message,
      };

      socket.emit(SOCKET_EVENT.REQUEST_ERROR, payload);

      const possibleAcknowledge = packet[packet.length - 1];

      if (typeof possibleAcknowledge === "function") {
        (possibleAcknowledge as (response: { ok: false; message: string }) => void)({
          ok: false,
          message: resolved.message,
        });
      }

      next(new Error("rate limit exceeded"));
      return;
    }

    resolved.store.set(rateKey, now);
    next();
  });
}
