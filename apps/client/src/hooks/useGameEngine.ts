import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import { GameEngine, type GameEngineHudState } from "../engine/GameEngine";

function createUserId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `user-${crypto.randomUUID().slice(0, 8)}`;
  }

  return `user-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultHudState(userId: string): GameEngineHudState {
  return {
    userId,
    connected: false,
    allianceTag: null,
    allianceColor: null,
    playerEnergy: 0,
    zoom: 1,
    centerQ: 0,
    centerR: 0,
    radius: 0,
    knownTiles: 0,
    visibleTiles: 0,
    ownedTiles: 0,
    ownedEnergy: 0,
    leaderboard: [],
    radarData: null,
  };
}

export function useGameEngine(serverUrl: string): {
  canvasRef: RefObject<HTMLDivElement>;
  hud: GameEngineHudState;
  setAllianceTag: (allianceTag: string | null) => Promise<boolean>;
} {
  const canvasRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const userId = useMemo(() => createUserId(), []);
  const [hud, setHud] = useState<GameEngineHudState>(() => defaultHudState(userId));

  useEffect(() => {
    if (!canvasRef.current) {
      return;
    }

    const engine = new GameEngine({
      mountElement: canvasRef.current,
      serverUrl,
      userId,
      onHudStateChange: setHud,
    });
    engineRef.current = engine;

    return () => {
      engineRef.current = null;
      engine.destroy();
    };
  }, [serverUrl, userId]);

  const setAllianceTag = useCallback((allianceTag: string | null) => {
    if (!engineRef.current) {
      return Promise.resolve(false);
    }

    return engineRef.current.setAllianceTag(allianceTag);
  }, []);

  return {
    canvasRef,
    hud,
    setAllianceTag,
  };
}
