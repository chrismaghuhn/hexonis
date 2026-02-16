import type { TileEventState } from "@hexonis/shared/events";
import { hex_to_pixel } from "@hexonis/shared/hexMath";
import { Container, Graphics } from "pixi.js";

export interface HexRendererOptions {
  container: Container;
  hexSize: number;
  localUserId: string;
}

interface TileRenderNode {
  tileGraphic: Graphics;
  nexusRing?: Graphics;
}

function tileKey(q: number, r: number): string {
  return `${q}:${r}`;
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

function parseHexColor(color: string | null): number | null {
  if (!color) {
    return null;
  }

  const normalized = color.trim();

  if (!/^#[0-9A-Fa-f]{6}$/.test(normalized)) {
    return null;
  }

  return Number.parseInt(normalized.slice(1), 16);
}

function ownerColor(
  ownerId: string | null,
  localUserId: string,
  allianceColor: string | null,
): number {
  const alliance = parseHexColor(allianceColor);

  if (alliance !== null) {
    return alliance;
  }

  if (!ownerId) {
    return 0x2e3640;
  }

  if (ownerId === localUserId) {
    return 0x4cbf79;
  }

  return 0x4f83b8;
}

function borderColor(
  ownerId: string | null,
  localUserId: string,
  allianceColor: string | null,
): number {
  const alliance = parseHexColor(allianceColor);

  if (alliance !== null) {
    return blendColor(alliance, 0xffffff, 0.28);
  }

  if (!ownerId) {
    return 0x4f5a68;
  }

  if (ownerId === localUserId) {
    return 0x96efc0;
  }

  return 0xa5d2f3;
}

function blendColor(colorA: number, colorB: number, amount: number): number {
  const mix = clamp(amount, 0, 1);
  const aR = (colorA >> 16) & 0xff;
  const aG = (colorA >> 8) & 0xff;
  const aB = colorA & 0xff;
  const bR = (colorB >> 16) & 0xff;
  const bG = (colorB >> 8) & 0xff;
  const bB = colorB & 0xff;
  const r = Math.round(aR + (bR - aR) * mix);
  const g = Math.round(aG + (bG - aG) * mix);
  const b = Math.round(aB + (bB - aB) * mix);

  return (r << 16) | (g << 8) | b;
}

function buildHexPoints(size: number): number[] {
  const points: number[] = [];

  for (let side = 0; side < 6; side += 1) {
    const angleRad = (Math.PI / 180) * (60 * side - 30);
    points.push(size * Math.cos(angleRad), size * Math.sin(angleRad));
  }

  return points;
}

function pulseSeedFromKey(key: string): number {
  let hash = 0;

  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) % 997;
  }

  return (hash / 997) * Math.PI * 2;
}

export class HexRenderer {
  private readonly container: Container;
  private readonly hexSize: number;
  private readonly localUserId: string;
  private readonly points: number[];
  private readonly nodesByTile = new Map<string, TileRenderNode>();

  private pulseSeconds = 0;

  constructor(options: HexRendererOptions) {
    this.container = options.container;
    this.hexSize = options.hexSize;
    this.localUserId = options.localUserId;
    this.points = buildHexPoints(this.hexSize);
  }

  sync(
    tileStore: ReadonlyMap<string, TileEventState>,
    visibleTileKeys: ReadonlySet<string>,
    dirtyTileKeys: ReadonlySet<string>,
  ): void {
    for (const [key, node] of this.nodesByTile) {
      if (visibleTileKeys.has(key)) {
        continue;
      }

      this.destroyNode(node);
      this.nodesByTile.delete(key);
    }

    for (const key of visibleTileKeys) {
      const tile = tileStore.get(key);

      if (!tile) {
        continue;
      }

      let node = this.nodesByTile.get(key);

      if (!node) {
        node = {
          tileGraphic: new Graphics(),
        };
        this.nodesByTile.set(key, node);
        this.container.addChild(node.tileGraphic);
        this.drawTile(node, key, tile);
        continue;
      }

      if (dirtyTileKeys.has(key)) {
        this.drawTile(node, key, tile);
      }
    }
  }

  animate(deltaSeconds: number): void {
    this.pulseSeconds += deltaSeconds;

    for (const [key, node] of this.nodesByTile) {
      if (!node.nexusRing) {
        continue;
      }

      const phase = pulseSeedFromKey(key);
      const pulse = 0.5 + 0.5 * Math.sin(this.pulseSeconds * 3 + phase);
      node.nexusRing.alpha = 0.25 + pulse * 0.65;
      node.nexusRing.scale.set(1 + pulse * 0.12);
    }
  }

  destroy(): void {
    for (const node of this.nodesByTile.values()) {
      this.destroyNode(node);
    }

    this.nodesByTile.clear();
  }

  private destroyNode(node: TileRenderNode): void {
    this.container.removeChild(node.tileGraphic);
    node.tileGraphic.destroy();

    if (node.nexusRing) {
      this.container.removeChild(node.nexusRing);
      node.nexusRing.destroy();
      node.nexusRing = undefined;
    }
  }

  private drawTile(node: TileRenderNode, key: string, tile: TileEventState): void {
    const center = hex_to_pixel(tile.q, tile.r, this.hexSize);
    const integrityFactor = clamp(tile.integrity / 100, 0, 1);
    const desaturation = 1 - integrityFactor;
    const baseFill = ownerColor(tile.ownerId, this.localUserId, tile.ownerAllianceColor);
    const baseStroke = borderColor(tile.ownerId, this.localUserId, tile.ownerAllianceColor);
    const fill = blendColor(baseFill, 0x646a72, desaturation);
    const stroke = blendColor(baseStroke, 0x6e7580, desaturation * 0.85);
    const alpha = clamp(0.12 + integrityFactor * 0.7 + tile.energy / 400, 0.12, 1);
    const lineAlpha = clamp(0.2 + integrityFactor * 0.8, 0.2, 1);

    node.tileGraphic.clear();
    node.tileGraphic.lineStyle(1, stroke, lineAlpha);
    node.tileGraphic.beginFill(fill, alpha);
    node.tileGraphic.drawPolygon(this.points);
    node.tileGraphic.endFill();
    node.tileGraphic.position.set(center.x, center.y);

    if (tile.tileType === "nexus") {
      if (!node.nexusRing) {
        node.nexusRing = new Graphics();
        this.container.addChild(node.nexusRing);
      }

      node.nexusRing.clear();
      node.nexusRing.lineStyle(2, 0xf2d17a, 0.95);
      node.nexusRing.drawCircle(0, 0, this.hexSize * 1.15);
      node.nexusRing.beginFill(0xf6d985, 0.25);
      node.nexusRing.drawCircle(0, 0, this.hexSize * 0.18);
      node.nexusRing.endFill();
      node.nexusRing.position.set(center.x, center.y);
      node.nexusRing.alpha = 0.75;
      node.nexusRing.scale.set(1);
      return;
    }

    if (node.nexusRing) {
      this.container.removeChild(node.nexusRing);
      node.nexusRing.destroy();
      node.nexusRing = undefined;
    }
  }

  static keyFromTile(tile: { q: number; r: number }): string {
    return tileKey(tile.q, tile.r);
  }
}
