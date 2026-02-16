import type {
  RadarDataPayload,
  RadarHotspotPoint,
  RadarNexusPoint,
  RadarPlayerBasePoint,
} from "@hexonis/shared/events";
import { hex_to_pixel } from "@hexonis/shared/hexMath";

export interface MiniMapProps {
  radarData: RadarDataPayload | null;
  playerQ: number;
  playerR: number;
}

const MAP_SIZE = 146;
const MAP_PADDING = 10;

function projectPoint(
  q: number,
  r: number,
  playerQ: number,
  playerR: number,
  radius: number,
): { x: number; y: number } {
  const playerPixel = hex_to_pixel(playerQ, playerR, 1);
  const targetPixel = hex_to_pixel(q, r, 1);
  const maxDistance = Math.max(1, Math.abs(hex_to_pixel(radius, 0, 1).x));
  const maxRenderRadius = MAP_SIZE * 0.5 - MAP_PADDING;
  const dx = ((targetPixel.x - playerPixel.x) / maxDistance) * maxRenderRadius;
  const dy = ((targetPixel.y - playerPixel.y) / maxDistance) * maxRenderRadius;

  return {
    x: MAP_SIZE * 0.5 + dx,
    y: MAP_SIZE * 0.5 + dy,
  };
}

function renderBasePoint(point: RadarPlayerBasePoint, playerQ: number, playerR: number, radius: number) {
  const projected = projectPoint(point.q, point.r, playerQ, playerR, radius);

  return <circle key={`base-${point.q}-${point.r}`} cx={projected.x} cy={projected.y} r={2.6} fill="#6ae89a" />;
}

function renderNexusPoint(point: RadarNexusPoint, playerQ: number, playerR: number, radius: number) {
  const projected = projectPoint(point.q, point.r, playerQ, playerR, radius);
  const ringRadius = Math.min(5.8, 2.2 + point.level * 0.35);

  return (
    <g key={`nexus-${point.q}-${point.r}`}>
      <circle cx={projected.x} cy={projected.y} r={ringRadius} fill="none" stroke="#f4d476" strokeWidth={1.2} />
      <circle cx={projected.x} cy={projected.y} r={2.2} fill="#f7df95" />
    </g>
  );
}

function renderHotspot(point: RadarHotspotPoint, playerQ: number, playerR: number, radius: number) {
  const projected = projectPoint(point.q, point.r, playerQ, playerR, radius);
  const hotspotRadius = Math.min(3.4, 1.5 + point.activity / 8);

  return (
    <circle
      key={`hotspot-${point.q}-${point.r}`}
      cx={projected.x}
      cy={projected.y}
      r={hotspotRadius}
      fill="#ffb26f"
      fillOpacity={0.65}
    />
  );
}

export function MiniMap({ radarData, playerQ, playerR }: MiniMapProps): JSX.Element {
  if (!radarData) {
    return <div className="mini-map-empty">Radar initializing...</div>;
  }

  return (
    <div className="mini-map-shell">
      <svg width={MAP_SIZE} height={MAP_SIZE} viewBox={`0 0 ${MAP_SIZE} ${MAP_SIZE}`} role="img">
        <rect x={0} y={0} width={MAP_SIZE} height={MAP_SIZE} rx={8} fill="rgba(8, 13, 18, 0.92)" />
        <circle
          cx={MAP_SIZE * 0.5}
          cy={MAP_SIZE * 0.5}
          r={MAP_SIZE * 0.5 - MAP_PADDING}
          fill="none"
          stroke="rgba(131, 176, 209, 0.34)"
          strokeWidth={1}
        />

        {radarData.hotspots.map((point) => renderHotspot(point, playerQ, playerR, radarData.radius))}
        {radarData.playerBases.map((point) => renderBasePoint(point, playerQ, playerR, radarData.radius))}
        {radarData.nexusCores.map((point) => renderNexusPoint(point, playerQ, playerR, radarData.radius))}

        <circle cx={MAP_SIZE * 0.5} cy={MAP_SIZE * 0.5} r={3.2} fill="#f3f8fb" />
      </svg>

      <div className="mini-map-legend">
        <span>
          <i className="dot base" /> Bases
        </span>
        <span>
          <i className="dot nexus" /> Nexus
        </span>
        <span>
          <i className="dot hot" /> Activity
        </span>
      </div>
    </div>
  );
}
