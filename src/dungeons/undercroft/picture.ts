// Undercroft's tile pictures: each tile a 28-pixel square drawn from a few
// rectangles and circles in one fixed palette, then encoded by the PNG
// writer. The autopilot's picture and the play view's map come from the
// same tiles; the view only dims what fog hides and draws at a larger scale.

import { encodePng, type PaletteImage, pngDataUrl } from "../../lib/png.ts";
import type { Pos, Tile, UndercroftMap } from "./map.ts";

/** Pixels per tile; close to one vision-model patch. */
export const TILE_PX = 28;

const COLORS = {
  void: [10, 9, 8],
  wall: [58, 52, 46],
  mortar: [38, 34, 30],
  floor: [122, 112, 98],
  floorDot: [108, 99, 86],
  stairs: [24, 21, 18],
  stairsEdge: [160, 150, 132],
  gold: [242, 193, 78],
  goldDark: [176, 128, 32],
  red: [214, 64, 54],
  redDark: [140, 34, 28],
  doorFrame: [44, 36, 28],
  monster: [124, 58, 160],
  monsterEye: [255, 236, 120],
  heroBody: [62, 106, 225],
  heroHead: [246, 231, 200],
  ink: [20, 18, 16],
  trail: [96, 160, 255],
} as const;
type ColorName = keyof typeof COLORS;
const NAMES = Object.keys(COLORS) as ColorName[];
/** Each colour twice: as drawn, then dimmed for tiles the hero cannot see now. */
const PALETTE: [number, number, number][] = [
  ...NAMES.map((n) => [...COLORS[n]] as [number, number, number]),
  ...NAMES.map(
    (n) =>
      COLORS[n].map((v) => Math.round(v * 0.38)) as [number, number, number],
  ),
];
const index = (name: ColorName, dim = false) =>
  NAMES.indexOf(name) + (dim ? NAMES.length : 0);

class Canvas {
  readonly pixels: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Uint8Array(width * height);
  }
  rect(x: number, y: number, w: number, h: number, color: number): void {
    for (let j = Math.max(0, y); j < Math.min(this.height, y + h); j++)
      this.pixels.fill(
        color,
        j * this.width + Math.max(0, x),
        j * this.width + Math.min(this.width, x + w),
      );
  }
  disc(cx: number, cy: number, r: number, color: number): void {
    for (let j = Math.floor(cy - r); j <= Math.ceil(cy + r); j++)
      for (let i = Math.floor(cx - r); i <= Math.ceil(cx + r); i++)
        if (
          (i + 0.5 - cx) ** 2 + (j + 0.5 - cy) ** 2 <= r * r &&
          i >= 0 &&
          j >= 0 &&
          i < this.width &&
          j < this.height
        )
          this.pixels[j * this.width + i] = color;
  }
}

function drawTile(
  c: Canvas,
  tile: Tile,
  x: number,
  y: number,
  dim: boolean,
): void {
  const T = TILE_PX;
  const k = (name: ColorName) => index(name, dim);
  if (tile === "wall") {
    c.rect(x, y, T, T, k("wall"));
    // Brick courses.
    for (let row = 0; row < 4; row++) {
      c.rect(x, y + row * 7, T, 1, k("mortar"));
      const off = row % 2 ? 7 : 0;
      for (let col = off; col < T; col += 14)
        c.rect(x + col, y + row * 7, 1, 7, k("mortar"));
    }
    return;
  }
  c.rect(x, y, T, T, k("floor"));
  c.rect(x + 6, y + 9, 2, 2, k("floorDot"));
  c.rect(x + 19, y + 18, 2, 2, k("floorDot"));
  if (tile === "stairs") {
    for (let s = 0; s < 4; s++) {
      c.rect(x + 3 + s * 2, y + 4 + s * 5, T - 6 - s * 4, 5, k("stairs"));
      c.rect(x + 3 + s * 2, y + 4 + s * 5, T - 6 - s * 4, 1, k("stairsEdge"));
    }
  } else if (tile === "gold") {
    c.disc(x + 10, y + 17, 5, k("goldDark"));
    c.disc(x + 10, y + 16, 4.5, k("gold"));
    c.disc(x + 18, y + 12, 5, k("goldDark"));
    c.disc(x + 18, y + 11, 4.5, k("gold"));
  } else if (tile === "monster") {
    c.disc(x + 14, y + 15, 10, k("monster"));
    c.rect(x + 4, y + 15, 20, 9, k("monster"));
    c.rect(x + 8, y + 11, 4, 4, k("monsterEye"));
    c.rect(x + 16, y + 11, 4, 4, k("monsterEye"));
    c.rect(x + 9, y + 12, 2, 2, k("ink"));
    c.rect(x + 17, y + 12, 2, 2, k("ink"));
    c.rect(x + 9, y + 19, 10, 2, k("ink"));
  } else if (tile.startsWith("key:")) {
    const [main, dark] =
      tile === "key:gold"
        ? (["gold", "goldDark"] as const)
        : (["red", "redDark"] as const);
    c.disc(x + 9, y + 14, 6, k(dark));
    c.disc(x + 9, y + 14, 5, k(main));
    c.disc(x + 9, y + 14, 2, k("floor"));
    c.rect(x + 13, y + 12, 12, 4, k(main));
    c.rect(x + 20, y + 16, 3, 5, k(main));
    c.rect(x + 24, y + 16, 2, 4, k(main));
  } else if (tile.startsWith("door:")) {
    const main = tile === "door:gold" ? "gold" : "red";
    c.rect(x + 2, y + 1, T - 4, T - 1, k("doorFrame"));
    c.rect(x + 5, y + 4, T - 10, T - 4, k(main));
    c.rect(x + 13, y + 4, 2, T - 4, k("doorFrame"));
    c.disc(x + 14, y + 15, 3, k("ink"));
    c.rect(x + 13, y + 16, 2, 5, k("ink"));
  }
}

function drawHero(c: Canvas, p: Pos): void {
  const x = p.col * TILE_PX;
  const y = p.row * TILE_PX;
  c.rect(x + 8, y + 13, 12, 12, index("heroBody"));
  c.rect(x + 5, y + 14, 3, 8, index("heroBody"));
  c.rect(x + 20, y + 14, 3, 8, index("heroBody"));
  c.disc(x + 14, y + 8, 5, index("heroHead"));
  c.rect(x + 12, y + 7, 1, 2, index("ink"));
  c.rect(x + 15, y + 7, 1, 2, index("ink"));
}

export interface PictureOptions {
  /** Tiles drawn dimmed (seen before, not in sight now); absent: all lit. */
  dimmed?: (p: Pos) => boolean;
  /** Tiles never seen, drawn as darkness. */
  hidden?: (p: Pos) => boolean;
  /** Tiles the hero walked, marked with a small dot. */
  trail?: Pos[];
}

/** The map with the hero on it, as a palette image. */
export function mapImage(
  m: UndercroftMap,
  hero: Pos,
  options: PictureOptions = {},
): PaletteImage {
  const c = new Canvas(m.cols * TILE_PX, m.rows * TILE_PX);
  c.rect(0, 0, c.width, c.height, index("void"));
  for (let row = 0; row < m.rows; row++)
    for (let col = 0; col < m.cols; col++) {
      const p = { row, col };
      if (options.hidden?.(p)) continue;
      drawTile(
        c,
        m.tiles[row]?.[col] ?? "wall",
        col * TILE_PX,
        row * TILE_PX,
        options.dimmed?.(p) ?? false,
      );
    }
  for (const t of options.trail ?? [])
    c.disc(
      t.col * TILE_PX + TILE_PX / 2,
      t.row * TILE_PX + TILE_PX / 2,
      2.5,
      index("trail"),
    );
  drawHero(c, hero);
  return {
    width: c.width,
    height: c.height,
    palette: PALETTE,
    pixels: c.pixels,
  };
}

/** The map picture as a PNG data URL. */
export async function mapPicture(
  m: UndercroftMap,
  hero: Pos,
  options: PictureOptions = {},
): Promise<string> {
  return pngDataUrl(await encodePng(mapImage(m, hero, options)));
}
