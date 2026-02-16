export interface HexTile {
  q: number;
  r: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface GameStateChunk {
  chunkQ: number;
  chunkR: number;
  tiles: HexTile[];
}

const SQRT_3 = Math.sqrt(3);

const AXIAL_DIRECTIONS: ReadonlyArray<HexTile> = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

function assertPositiveSize(size: number): void {
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("size must be a finite number greater than 0");
  }
}

function roundAxial(q: number, r: number): HexTile {
  const x = q;
  const z = r;
  const y = -x - z;

  let roundedX = Math.round(x);
  let roundedY = Math.round(y);
  let roundedZ = Math.round(z);

  const xDiff = Math.abs(roundedX - x);
  const yDiff = Math.abs(roundedY - y);
  const zDiff = Math.abs(roundedZ - z);

  if (xDiff > yDiff && xDiff > zDiff) {
    roundedX = -roundedY - roundedZ;
  } else if (yDiff > zDiff) {
    roundedY = -roundedX - roundedZ;
  } else {
    roundedZ = -roundedX - roundedY;
  }

  return { q: roundedX, r: roundedZ };
}

export function hex_distance(a: Readonly<HexTile>, b: Readonly<HexTile>): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;

  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function hex_to_pixel(q: number, r: number, size: number): Point {
  assertPositiveSize(size);

  return {
    x: size * SQRT_3 * (q + r / 2),
    y: size * 1.5 * r,
  };
}

export function pixel_to_hex(x: number, y: number, size: number): HexTile {
  assertPositiveSize(size);

  const fractionalQ = ((SQRT_3 / 3) * x - y / 3) / size;
  const fractionalR = ((2 / 3) * y) / size;

  return roundAxial(fractionalQ, fractionalR);
}

export function get_neighbors(q: number, r: number): HexTile[] {
  return AXIAL_DIRECTIONS.map((direction) => ({
    q: q + direction.q,
    r: r + direction.r,
  }));
}
