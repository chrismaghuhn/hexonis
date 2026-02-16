import { HudOverlay } from "./components/HudOverlay";
import { Leaderboard } from "./components/Leaderboard";
import { useGameEngine } from "./hooks/useGameEngine";

const DEFAULT_SERVER_URL = "http://localhost:3001";

export default function App(): JSX.Element {
  const serverUrl =
    import.meta.env.VITE_SOCKET_URL ?? import.meta.env.VITE_SERVER_URL ?? DEFAULT_SERVER_URL;
  const { canvasRef, hud, setAllianceTag } = useGameEngine(serverUrl);

  return (
    <main className="app-shell">
      <section className="game-canvas" ref={canvasRef} />
      <HudOverlay hud={hud} />
      <Leaderboard
        entries={hud.leaderboard}
        currentUserId={hud.userId}
        allianceTag={hud.allianceTag}
        allianceColor={hud.allianceColor}
        onSetAllianceTag={setAllianceTag}
      />
    </main>
  );
}
