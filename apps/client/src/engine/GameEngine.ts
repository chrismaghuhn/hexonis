import {
  SOCKET_EVENT,
  type ClaimTileAck,
  type ClientToServerEvents,
  type EnergyUpdatePayload,
  type GetLeaderboardPayload,
  type InterServerEvents,
  type LeaderboardAck,
  type LeaderboardEntry,
  type LeaderboardUpdatePayload,
  type PlayerProfilePayload,
  type RadarDataAck,
  type RadarDataPayload,
  type RadarRequestPayload,
  type RepairTileAck,
  type RequestErrorPayload,
  type SetAllianceTagAck,
  type ServerToClientEvents,
  type SyncViewAck,
  type SyncViewPayload,
  type TileClaimedPayload,
  type TileRepairedPayload,
  type TileEventState,
  type ViewUpdatePayload,
} from "@hexonis/shared/events";
import { hex_distance, pixel_to_hex, type HexTile } from "@hexonis/shared/hexMath";
import { Application, Container, Rectangle } from "pixi.js";
import { Viewport } from "pixi-viewport";
import { io, type Socket } from "socket.io-client";

import { HexRenderer } from "./HexRenderer";

export interface GameEngineHudState {
  userId: string;
  connected: boolean;
  allianceTag: string | null;
  allianceColor: string | null;
  playerEnergy: number;
  zoom: number;
  centerQ: number;
  centerR: number;
  radius: number;
  knownTiles: number;
  visibleTiles: number;
  ownedTiles: number;
  ownedEnergy: number;
  leaderboard: LeaderboardEntry[];
  radarData: RadarDataPayload | null;
}

export interface GameEngineOptions {
  mountElement: HTMLElement;
  serverUrl?: string;
  userId: string;
  hexSize?: number;
  minZoom?: number;
  maxZoom?: number;
  onHudStateChange?: (state: GameEngineHudState) => void;
}

type RealtimeSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const DEFAULT_SOCKET_URL = "http://localhost:3001";

function tileKey(tile: HexTile): string {
  return `${tile.q}:${tile.r}`;
}

function sameViewQuery(a: SyncViewPayload | undefined, b: SyncViewPayload): boolean {
  if (!a) {
    return false;
  }

  return a.centerQ === b.centerQ && a.centerR === b.centerR && a.radius === b.radius;
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function resolveSocketUrl(explicitUrl?: string): string {
  if (explicitUrl && explicitUrl.trim().length > 0) {
    return explicitUrl;
  }

  const env = import.meta.env as Record<string, string | undefined>;

  return env.VITE_SOCKET_URL ?? env.VITE_SERVER_URL ?? DEFAULT_SOCKET_URL;
}

export class GameEngine {
  private readonly mountElement: HTMLElement;
  private readonly app: Application;
  private readonly viewport: Viewport;
  private readonly worldLayer: Container;
  private readonly socket: RealtimeSocket;
  private readonly hexRenderer: HexRenderer;
  private readonly knownTiles = new Map<string, TileEventState>();
  private readonly userId: string;
  private readonly hexSize: number;
  private readonly onHudStateChange?: (state: GameEngineHudState) => void;

  private visibleTileKeys = new Set<string>();
  private allianceTag: string | null = null;
  private allianceColor: string | null = null;
  private playerEnergy = 0;
  private leaderboard: LeaderboardEntry[] = [];
  private radarData: RadarDataPayload | null = null;
  private resizeObserver?: ResizeObserver;
  private syncTimer?: ReturnType<typeof setTimeout>;
  private radarTimer?: ReturnType<typeof setTimeout>;
  private leaderboardTimer?: ReturnType<typeof setTimeout>;
  private lastSentSync?: SyncViewPayload;
  private lastSentRadar?: RadarRequestPayload;
  private latestView: SyncViewPayload = { centerQ: 0, centerR: 0, radius: 0 };
  private destroyed = false;

  constructor(options: GameEngineOptions) {
    this.mountElement = options.mountElement;
    this.userId = options.userId;
    this.hexSize = options.hexSize ?? 32;
    this.onHudStateChange = options.onHudStateChange;
    const socketUrl = resolveSocketUrl(options.serverUrl);

    this.app = new Application({
      antialias: true,
      backgroundAlpha: 0,
      resizeTo: this.mountElement,
      powerPreference: "high-performance",
    });

    const canvas = this.app.view as HTMLCanvasElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    this.mountElement.appendChild(canvas);

    this.worldLayer = new Container();

    this.viewport = new Viewport({
      screenWidth: Math.max(this.mountElement.clientWidth, 1),
      screenHeight: Math.max(this.mountElement.clientHeight, 1),
      worldWidth: 8_000_000,
      worldHeight: 8_000_000,
      interaction: this.app.renderer.plugins.interaction,
    });

    this.viewport.addChild(this.worldLayer);
    this.viewport.drag().pinch().wheel().decelerate();
    this.viewport.clampZoom({
      minScale: options.minZoom ?? 0.2,
      maxScale: options.maxZoom ?? 4,
    });
    this.viewport.moveCenter(0, 0);
    this.app.stage.addChild(this.viewport);

    this.app.stage.interactive = true;
    this.app.stage.hitArea = new Rectangle(0, 0, this.app.screen.width, this.app.screen.height);
    this.app.stage.on("pointertap", this.handlePointerTap);

    this.viewport.on("moved", this.handleViewportChanged);
    this.viewport.on("zoomed", this.handleViewportChanged);
    this.app.ticker.add(this.handleTicker);

    this.hexRenderer = new HexRenderer({
      container: this.worldLayer,
      hexSize: this.hexSize,
      localUserId: this.userId,
    });

    this.socket = io(socketUrl, {
      transports: ["websocket"],
      auth: {
        userId: this.userId,
      },
    });

    this.socket.on("connect", this.handleConnect);
    this.socket.on("disconnect", this.handleDisconnect);
    this.socket.on(SOCKET_EVENT.VIEW_UPDATE, this.handleViewUpdate);
    this.socket.on(SOCKET_EVENT.RADAR_DATA, this.handleRadarData);
    this.socket.on(SOCKET_EVENT.LEADERBOARD_UPDATE, this.handleLeaderboardUpdate);
    this.socket.on(SOCKET_EVENT.PROFILE_UPDATE, this.handleProfileUpdate);
    this.socket.on(SOCKET_EVENT.TILE_CLAIMED, this.handleTileClaimed);
    this.socket.on(SOCKET_EVENT.TILE_REPAIRED, this.handleTileRepaired);
    this.socket.on(SOCKET_EVENT.ENERGY_UPDATE, this.handleEnergyUpdate);
    this.socket.on(SOCKET_EVENT.REQUEST_ERROR, this.handleRequestError);

    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(this.mountElement);

    this.scheduleSyncView();
    this.emitHudState();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }

    if (this.radarTimer) {
      clearTimeout(this.radarTimer);
      this.radarTimer = undefined;
    }

    if (this.leaderboardTimer) {
      clearTimeout(this.leaderboardTimer);
      this.leaderboardTimer = undefined;
    }

    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;

    this.app.stage.off("pointertap", this.handlePointerTap);
    this.app.ticker.remove(this.handleTicker);

    this.viewport.off("moved", this.handleViewportChanged);
    this.viewport.off("zoomed", this.handleViewportChanged);

    this.socket.off("connect", this.handleConnect);
    this.socket.off("disconnect", this.handleDisconnect);
    this.socket.off(SOCKET_EVENT.VIEW_UPDATE, this.handleViewUpdate);
    this.socket.off(SOCKET_EVENT.RADAR_DATA, this.handleRadarData);
    this.socket.off(SOCKET_EVENT.LEADERBOARD_UPDATE, this.handleLeaderboardUpdate);
    this.socket.off(SOCKET_EVENT.PROFILE_UPDATE, this.handleProfileUpdate);
    this.socket.off(SOCKET_EVENT.TILE_CLAIMED, this.handleTileClaimed);
    this.socket.off(SOCKET_EVENT.TILE_REPAIRED, this.handleTileRepaired);
    this.socket.off(SOCKET_EVENT.ENERGY_UPDATE, this.handleEnergyUpdate);
    this.socket.off(SOCKET_EVENT.REQUEST_ERROR, this.handleRequestError);
    this.socket.disconnect();

    this.hexRenderer.destroy();
    this.viewport.destroy({ children: true });
    this.app.destroy(true);
  }

  private readonly handleConnect = (): void => {
    this.scheduleSyncView(true);
    this.scheduleRadarRequest(true);
    this.scheduleLeaderboardRequest(true);
    this.emitHudState();
  };

  private readonly handleDisconnect = (): void => {
    this.emitHudState();
  };

  private readonly handleViewportChanged = (): void => {
    this.scheduleSyncView();
    this.scheduleRadarRequest();
    this.emitHudState();
  };

  private readonly handleTicker = (delta: number): void => {
    this.hexRenderer.animate(delta / 60);
  };

  private readonly handleRequestError = (payload: RequestErrorPayload): void => {
    console.warn("[socket] request_error", payload);
  };

  private readonly handleViewUpdate = (payload: ViewUpdatePayload): void => {
    const nextVisible = new Set<string>();
    const dirtyKeys = new Set<string>();

    for (const tile of payload.tiles) {
      const key = tileKey(tile);
      nextVisible.add(key);

      const previous = this.knownTiles.get(key);

      if (
        !previous ||
        previous.ownerId !== tile.ownerId ||
        previous.energy !== tile.energy ||
        previous.integrity !== tile.integrity ||
        previous.tileType !== tile.tileType
      ) {
        dirtyKeys.add(key);
      }

      this.knownTiles.set(key, tile);
    }

    this.visibleTileKeys = nextVisible;
    this.latestView = {
      centerQ: payload.centerQ,
      centerR: payload.centerR,
      radius: payload.radius,
    };

    this.hexRenderer.sync(this.knownTiles, this.visibleTileKeys, dirtyKeys);
    this.emitHudState();
  };

  private readonly handleRadarData = (payload: RadarDataPayload): void => {
    this.radarData = payload;
    this.emitHudState();
  };

  private readonly handleLeaderboardUpdate = (payload: LeaderboardUpdatePayload): void => {
    this.leaderboard = payload.entries;
    this.emitHudState();
  };

  private readonly handleProfileUpdate = (payload: PlayerProfilePayload): void => {
    if (payload.userId !== this.userId) {
      return;
    }

    this.allianceTag = payload.allianceTag;
    this.allianceColor = payload.allianceColor;
    this.emitHudState();
  };

  private readonly handleTileClaimed = (payload: TileClaimedPayload): void => {
    const key = tileKey(payload.tile);
    const previous = this.knownTiles.get(key);
    const isDirty =
      !previous ||
      previous.ownerId !== payload.tile.ownerId ||
      previous.energy !== payload.tile.energy ||
      previous.integrity !== payload.tile.integrity ||
      previous.tileType !== payload.tile.tileType;

    this.knownTiles.set(key, payload.tile);

    if (isDirty && this.visibleTileKeys.has(key)) {
      this.hexRenderer.sync(this.knownTiles, this.visibleTileKeys, new Set([key]));
    }

    this.emitHudState();
  };

  private readonly handleTileRepaired = (payload: TileRepairedPayload): void => {
    const key = tileKey(payload.tile);
    const previous = this.knownTiles.get(key);
    const isDirty =
      !previous ||
      previous.ownerId !== payload.tile.ownerId ||
      previous.energy !== payload.tile.energy ||
      previous.integrity !== payload.tile.integrity ||
      previous.tileType !== payload.tile.tileType;

    this.knownTiles.set(key, payload.tile);

    if (isDirty && this.visibleTileKeys.has(key)) {
      this.hexRenderer.sync(this.knownTiles, this.visibleTileKeys, new Set([key]));
    }

    this.emitHudState();
  };

  private readonly handleEnergyUpdate = (payload: EnergyUpdatePayload): void => {
    if (payload.userId !== this.userId) {
      return;
    }

    this.playerEnergy = payload.energy;
    this.emitHudState();
  };

  private readonly handlePointerTap = (event: {
    data: { global: { x: number; y: number }; originalEvent?: Event };
  }): void => {
    const world = this.viewport.toWorld(event.data.global.x, event.data.global.y);
    const tile = pixel_to_hex(world.x, world.y, this.hexSize);

    const wantsRepair =
      event.data.originalEvent instanceof MouseEvent && event.data.originalEvent.shiftKey;

    if (wantsRepair) {
      this.socket.emit(
        SOCKET_EVENT.REPAIR_TILE,
        { q: tile.q, r: tile.r },
        (acknowledge: RepairTileAck) => {
          if (!acknowledge.ok) {
            console.warn("[socket] repair_tile failed", acknowledge.message);
          }
        },
      );

      return;
    }

    this.socket.emit(
      SOCKET_EVENT.CLAIM_TILE,
      { q: tile.q, r: tile.r },
      (acknowledge: ClaimTileAck) => {
        if (!acknowledge.ok) {
          console.warn("[socket] claim_tile failed", acknowledge.message);
        }
      },
    );
  };

  private handleResize(): void {
    const width = Math.max(this.mountElement.clientWidth, 1);
    const height = Math.max(this.mountElement.clientHeight, 1);

    this.viewport.resize(width, height, this.viewport.worldWidth, this.viewport.worldHeight);
    this.app.stage.hitArea = new Rectangle(0, 0, width, height);
    this.scheduleSyncView(true);
    this.scheduleRadarRequest(true);
    this.scheduleLeaderboardRequest(true);
  }

  private scheduleSyncView(force = false): void {
    if (this.destroyed) {
      return;
    }

    if (force && this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }

    if (this.syncTimer) {
      return;
    }

    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      this.sendSyncView(force);
    }, 60);
  }

  private scheduleRadarRequest(force = false): void {
    if (this.destroyed) {
      return;
    }

    if (force && this.radarTimer) {
      clearTimeout(this.radarTimer);
      this.radarTimer = undefined;
    }

    if (this.radarTimer) {
      return;
    }

    this.radarTimer = setTimeout(() => {
      this.radarTimer = undefined;
      this.sendRadarRequest(force);
    }, 2100);
  }

  private scheduleLeaderboardRequest(force = false): void {
    if (this.destroyed) {
      return;
    }

    if (force && this.leaderboardTimer) {
      clearTimeout(this.leaderboardTimer);
      this.leaderboardTimer = undefined;
    }

    if (this.leaderboardTimer) {
      return;
    }

    this.leaderboardTimer = setTimeout(() => {
      this.leaderboardTimer = undefined;
      this.requestLeaderboard();
      this.scheduleLeaderboardRequest();
    }, 4000);
  }

  private sendSyncView(force: boolean): void {
    if (!this.socket.connected) {
      return;
    }

    const query = this.computeSyncViewPayload();

    if (!force && sameViewQuery(this.lastSentSync, query)) {
      return;
    }

    this.lastSentSync = query;
    this.latestView = query;

    this.socket.emit(SOCKET_EVENT.SYNC_VIEW, query, (acknowledge: SyncViewAck) => {
      if (!acknowledge.ok) {
        console.warn("[socket] sync_view failed", acknowledge.message);
      }
    });
  }

  private sendRadarRequest(force: boolean): void {
    if (!this.socket.connected) {
      return;
    }

    const currentView = this.computeSyncViewPayload();
    const request: RadarRequestPayload = {
      centerQ: currentView.centerQ,
      centerR: currentView.centerR,
      radius: 500,
    };

    if (!force && this.lastSentRadar && sameViewQuery(this.lastSentRadar, request)) {
      return;
    }

    this.lastSentRadar = request;

    this.socket.emit(SOCKET_EVENT.GET_RADAR_DATA, request, (acknowledge: RadarDataAck) => {
      if (!acknowledge.ok) {
        console.warn("[socket] get_radar_data failed", acknowledge.message);
      }
    });
  }

  private requestLeaderboard(limit = 10): void {
    if (!this.socket.connected) {
      return;
    }

    const payload: GetLeaderboardPayload = { limit };

    this.socket.emit(SOCKET_EVENT.GET_LEADERBOARD, payload, (acknowledge: LeaderboardAck) => {
      if (!acknowledge.ok) {
        console.warn("[socket] get_leaderboard failed", acknowledge.message);
      }
    });
  }

  async setAllianceTag(allianceTag: string | null): Promise<boolean> {
    if (!this.socket.connected) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      this.socket.emit(
        SOCKET_EVENT.SET_ALLIANCE_TAG,
        { allianceTag },
        (acknowledge: SetAllianceTagAck) => {
          if (!acknowledge.ok) {
            console.warn("[socket] set_alliance_tag failed", acknowledge.message);
            resolve(false);
            return;
          }

          this.allianceTag = acknowledge.profile.allianceTag;
          this.allianceColor = acknowledge.profile.allianceColor;
          this.emitHudState();
          this.requestLeaderboard();
          resolve(true);
        },
      );
    });
  }

  private computeSyncViewPayload(): SyncViewPayload {
    const width = Math.max(this.app.screen.width, 1);
    const height = Math.max(this.app.screen.height, 1);
    const centerPoint = this.viewport.toWorld(width * 0.5, height * 0.5);
    const centerHex = pixel_to_hex(centerPoint.x, centerPoint.y, this.hexSize);

    const corners = [
      this.viewport.toWorld(0, 0),
      this.viewport.toWorld(width, 0),
      this.viewport.toWorld(width, height),
      this.viewport.toWorld(0, height),
    ];

    let radius = 1;

    for (const corner of corners) {
      const cornerHex = pixel_to_hex(corner.x, corner.y, this.hexSize);
      radius = Math.max(radius, Math.ceil(hex_distance(centerHex, cornerHex)));
    }

    return {
      centerQ: centerHex.q,
      centerR: centerHex.r,
      radius: radius + 1,
    };
  }

  private emitHudState(): void {
    if (!this.onHudStateChange) {
      return;
    }

    let ownedTiles = 0;
    let ownedEnergy = 0;

    for (const tile of this.knownTiles.values()) {
      if (tile.ownerId !== this.userId) {
        continue;
      }

      ownedTiles += 1;
      ownedEnergy += tile.energy;
    }

    this.onHudStateChange({
      userId: this.userId,
      connected: this.socket.connected,
      allianceTag: this.allianceTag,
      allianceColor: this.allianceColor,
      playerEnergy: roundTwo(this.playerEnergy),
      zoom: roundTwo(this.viewport.scale.x),
      centerQ: this.latestView.centerQ,
      centerR: this.latestView.centerR,
      radius: this.latestView.radius,
      knownTiles: this.knownTiles.size,
      visibleTiles: this.visibleTileKeys.size,
      ownedTiles,
      ownedEnergy: roundTwo(ownedEnergy),
      leaderboard: this.leaderboard,
      radarData: this.radarData,
    });
  }
}
