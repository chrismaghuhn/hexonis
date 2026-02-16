import type { HexTile } from "./hexMath";

export const SOCKET_EVENT = {
  SYNC_VIEW: "sync_view",
  VIEW_UPDATE: "view_update",
  GET_RADAR_DATA: "get_radar_data",
  RADAR_DATA: "radar_data",
  GET_LEADERBOARD: "get_leaderboard",
  LEADERBOARD_UPDATE: "leaderboard_update",
  SET_ALLIANCE_TAG: "set_alliance_tag",
  PROFILE_UPDATE: "profile_update",
  CLAIM_TILE: "claim_tile",
  TILE_CLAIMED: "tile_claimed",
  REPAIR_TILE: "repair_tile",
  TILE_REPAIRED: "tile_repaired",
  ENERGY_UPDATE: "energy_update",
  REQUEST_ERROR: "request_error",
} as const;

export interface PlayerProfilePayload {
  userId: string;
  displayName: string;
  allianceTag: string | null;
  allianceColor: string | null;
}

export interface TileEventState extends HexTile {
  ownerId: string | null;
  ownerAllianceTag: string | null;
  ownerAllianceColor: string | null;
  energy: number;
  lastUpdate: number;
  integrity: number;
  level: number;
  tileType: "normal" | "nexus";
}

export interface SyncViewPayload {
  centerQ: number;
  centerR: number;
  radius: number;
}

export interface ViewUpdatePayload {
  centerQ: number;
  centerR: number;
  radius: number;
  chunkIds: string[];
  tiles: TileEventState[];
}

export interface RadarRequestPayload {
  centerQ: number;
  centerR: number;
  radius: number;
}

export interface RadarNexusPoint extends HexTile {
  level: number;
}

export interface RadarPlayerBasePoint extends HexTile {
  ownerId: string;
}

export interface RadarHotspotPoint extends HexTile {
  activity: number;
}

export interface RadarDataPayload {
  centerQ: number;
  centerR: number;
  radius: number;
  nexusCores: RadarNexusPoint[];
  playerBases: RadarPlayerBasePoint[];
  hotspots: RadarHotspotPoint[];
}

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  allianceTag: string | null;
  allianceColor: string | null;
  score: number;
}

export interface GetLeaderboardPayload {
  limit?: number;
}

export interface LeaderboardUpdatePayload {
  entries: LeaderboardEntry[];
  updatedAt: number;
}

export interface SetAllianceTagPayload {
  allianceTag: string | null;
}

export interface ClaimTilePayload {
  q: number;
  r: number;
}

export interface RepairTilePayload {
  q: number;
  r: number;
}

export interface TileClaimedPayload {
  chunkId: string;
  tile: TileEventState;
  claimedByUserId: string;
  created: boolean;
  captured: boolean;
  energyCost: number;
}

export interface TileRepairedPayload {
  chunkId: string;
  tile: TileEventState;
  repairedByUserId: string;
  energyCost: number;
}

export interface EnergyUpdatePayload {
  userId: string;
  energy: number;
}

export interface RequestErrorPayload {
  event:
    | typeof SOCKET_EVENT.SYNC_VIEW
    | typeof SOCKET_EVENT.GET_RADAR_DATA
    | typeof SOCKET_EVENT.GET_LEADERBOARD
    | typeof SOCKET_EVENT.SET_ALLIANCE_TAG
    | typeof SOCKET_EVENT.CLAIM_TILE
    | typeof SOCKET_EVENT.REPAIR_TILE;
  message: string;
}

export interface SyncViewAckSuccess {
  ok: true;
  chunkIds: string[];
  tileCount: number;
}

export interface SyncViewAckFailure {
  ok: false;
  message: string;
}

export type SyncViewAck = SyncViewAckSuccess | SyncViewAckFailure;

export interface RadarDataAckSuccess {
  ok: true;
  nexusCount: number;
  baseCount: number;
  hotspotCount: number;
}

export interface RadarDataAckFailure {
  ok: false;
  message: string;
}

export type RadarDataAck = RadarDataAckSuccess | RadarDataAckFailure;

export interface LeaderboardAckSuccess {
  ok: true;
  count: number;
}

export interface LeaderboardAckFailure {
  ok: false;
  message: string;
}

export type LeaderboardAck = LeaderboardAckSuccess | LeaderboardAckFailure;

export interface SetAllianceTagAckSuccess {
  ok: true;
  profile: PlayerProfilePayload;
}

export interface SetAllianceTagAckFailure {
  ok: false;
  message: string;
}

export type SetAllianceTagAck = SetAllianceTagAckSuccess | SetAllianceTagAckFailure;

export interface ClaimTileAckSuccess {
  ok: true;
  created: boolean;
  captured: boolean;
  tile: TileEventState;
  energyAfter: number;
  energyCost: number;
}

export interface ClaimTileAckFailure {
  ok: false;
  message: string;
  reason?: "already-claimed" | "insufficient-energy" | "out-of-range";
  tile?: TileEventState | null;
  requiredEnergy?: number;
  maxDistance?: number;
  nearestDistance?: number | null;
  playerEnergy?: number;
}

export type ClaimTileAck = ClaimTileAckSuccess | ClaimTileAckFailure;

export interface RepairTileAckSuccess {
  ok: true;
  tile: TileEventState;
  energyAfter: number;
  energyCost: number;
}

export interface RepairTileAckFailure {
  ok: false;
  message: string;
  reason?: "tile-not-found" | "not-owner" | "insufficient-energy";
  tile?: TileEventState | null;
  requiredEnergy?: number;
  playerEnergy?: number;
}

export type RepairTileAck = RepairTileAckSuccess | RepairTileAckFailure;

export interface ClientToServerEvents {
  [SOCKET_EVENT.SYNC_VIEW]: (
    payload: SyncViewPayload,
    acknowledge?: (response: SyncViewAck) => void,
  ) => void;
  [SOCKET_EVENT.GET_RADAR_DATA]: (
    payload: RadarRequestPayload,
    acknowledge?: (response: RadarDataAck) => void,
  ) => void;
  [SOCKET_EVENT.GET_LEADERBOARD]: (
    payload: GetLeaderboardPayload,
    acknowledge?: (response: LeaderboardAck) => void,
  ) => void;
  [SOCKET_EVENT.SET_ALLIANCE_TAG]: (
    payload: SetAllianceTagPayload,
    acknowledge?: (response: SetAllianceTagAck) => void,
  ) => void;
  [SOCKET_EVENT.CLAIM_TILE]: (
    payload: ClaimTilePayload,
    acknowledge?: (response: ClaimTileAck) => void,
  ) => void;
  [SOCKET_EVENT.REPAIR_TILE]: (
    payload: RepairTilePayload,
    acknowledge?: (response: RepairTileAck) => void,
  ) => void;
}

export interface ServerToClientEvents {
  [SOCKET_EVENT.VIEW_UPDATE]: (payload: ViewUpdatePayload) => void;
  [SOCKET_EVENT.RADAR_DATA]: (payload: RadarDataPayload) => void;
  [SOCKET_EVENT.LEADERBOARD_UPDATE]: (payload: LeaderboardUpdatePayload) => void;
  [SOCKET_EVENT.PROFILE_UPDATE]: (payload: PlayerProfilePayload) => void;
  [SOCKET_EVENT.TILE_CLAIMED]: (payload: TileClaimedPayload) => void;
  [SOCKET_EVENT.TILE_REPAIRED]: (payload: TileRepairedPayload) => void;
  [SOCKET_EVENT.ENERGY_UPDATE]: (payload: EnergyUpdatePayload) => void;
  [SOCKET_EVENT.REQUEST_ERROR]: (payload: RequestErrorPayload) => void;
}

export interface InterServerEvents {}
