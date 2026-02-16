import type { GameEngineHudState } from "../engine/GameEngine";
import { MiniMap } from "./MiniMap";

export interface HudOverlayProps {
  hud: GameEngineHudState;
}

function statusLabel(connected: boolean): string {
  return connected ? "Connected" : "Disconnected";
}

export function HudOverlay({ hud }: HudOverlayProps): JSX.Element {
  return (
    <aside className="hud-overlay">
      <div className="hud-block">
        <div className="hud-label">User</div>
        <div className="hud-value mono">{hud.userId}</div>
      </div>

      <div className="hud-grid">
        <div className="hud-item">
          <span className="hud-label">Status</span>
          <span className={`hud-value ${hud.connected ? "ok" : "warn"}`}>
            {statusLabel(hud.connected)}
          </span>
        </div>

        <div className="hud-item">
          <span className="hud-label">Player Energy</span>
          <span className="hud-value">{hud.playerEnergy}</span>
        </div>

        <div className="hud-item">
          <span className="hud-label">Alliance</span>
          <span className="hud-value" style={hud.allianceColor ? { color: hud.allianceColor } : undefined}>
            {hud.allianceTag ?? "None"}
          </span>
        </div>

        <div className="hud-item">
          <span className="hud-label">Owned Energy</span>
          <span className="hud-value">{hud.ownedEnergy}</span>
        </div>

        <div className="hud-item">
          <span className="hud-label">Owned Tiles</span>
          <span className="hud-value">{hud.ownedTiles}</span>
        </div>

        <div className="hud-item">
          <span className="hud-label">Visible Tiles</span>
          <span className="hud-value">{hud.visibleTiles}</span>
        </div>

        <div className="hud-item">
          <span className="hud-label">Known Tiles</span>
          <span className="hud-value">{hud.knownTiles}</span>
        </div>

        <div className="hud-item">
          <span className="hud-label">Camera</span>
          <span className="hud-value mono">
            ({hud.centerQ}, {hud.centerR}) r={hud.radius}
          </span>
        </div>

        <div className="hud-item">
          <span className="hud-label">Coordinates</span>
          <span className="hud-value mono">
            q={hud.centerQ} r={hud.centerR}
          </span>
        </div>

        <div className="hud-item">
          <span className="hud-label">Zoom</span>
          <span className="hud-value">{hud.zoom.toFixed(2)}x</span>
        </div>

        <div className="hud-item">
          <span className="hud-label">Input</span>
          <span className="hud-value mono">Click claim / Shift+Click repair</span>
        </div>
      </div>

      <MiniMap radarData={hud.radarData} playerQ={hud.centerQ} playerR={hud.centerR} />
    </aside>
  );
}
