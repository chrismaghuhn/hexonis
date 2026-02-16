import { describe, expect, it } from "vitest";

import {
  get_neighbors,
  hex_distance,
  hex_to_pixel,
  pixel_to_hex,
  type HexTile,
} from "./hexMath";

describe("hex_distance", () => {
  it("returns 0 for identical tiles", () => {
    const tile: HexTile = { q: 4, r: -2 };

    expect(hex_distance(tile, tile)).toBe(0);
  });

  it("returns 1 for each direct neighbor", () => {
    const origin: HexTile = { q: 0, r: 0 };
    const neighbors = get_neighbors(origin.q, origin.r);

    for (const neighbor of neighbors) {
      expect(hex_distance(origin, neighbor)).toBe(1);
    }
  });

  it("is symmetrical", () => {
    const a: HexTile = { q: -3, r: 5 };
    const b: HexTile = { q: 4, r: -1 };

    expect(hex_distance(a, b)).toBe(hex_distance(b, a));
  });

  it("matches known distance fixtures", () => {
    const fixtures: Array<{ a: HexTile; b: HexTile; expected: number }> = [
      { a: { q: 0, r: 0 }, b: { q: 3, r: -1 }, expected: 3 },
      { a: { q: 1, r: -4 }, b: { q: -2, r: 2 }, expected: 6 },
      { a: { q: -4, r: 2 }, b: { q: 1, r: -2 }, expected: 5 },
      { a: { q: 7, r: -3 }, b: { q: -1, r: -1 }, expected: 8 },
    ];

    for (const fixture of fixtures) {
      expect(hex_distance(fixture.a, fixture.b)).toBe(fixture.expected);
    }
  });
});

describe("hex/pixel conversions", () => {
  it("converts hex to pixel and back to the same tile", () => {
    const size = 48;
    const fixtures: HexTile[] = [
      { q: 0, r: 0 },
      { q: 2, r: -3 },
      { q: -5, r: 1 },
      { q: 8, r: -4 },
    ];

    for (const fixture of fixtures) {
      const pixel = hex_to_pixel(fixture.q, fixture.r, size);
      const rounded = pixel_to_hex(pixel.x, pixel.y, size);

      expect(rounded).toEqual(fixture);
    }
  });

  it("throws for invalid tile size", () => {
    expect(() => hex_to_pixel(0, 0, 0)).toThrow();
    expect(() => pixel_to_hex(0, 0, -2)).toThrow();
    expect(() => pixel_to_hex(0, 0, Number.NaN)).toThrow();
  });
});

describe("get_neighbors", () => {
  it("returns six unique neighboring tiles", () => {
    const neighbors = get_neighbors(3, -2);
    const serialized = new Set(neighbors.map((tile) => `${tile.q},${tile.r}`));

    expect(neighbors).toHaveLength(6);
    expect(serialized.size).toBe(6);
  });
});
