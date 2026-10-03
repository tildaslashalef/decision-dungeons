// Undercroft's maps: seeded grids of walls and floor with keys and their
// doors, static monsters, gold, and the stairs out. Every map is built so
// the stairs are reachable without a hit point lost, and its optimum, the
// fewest moves over (position, keys held), is known by breadth-first
// search. Pure and deterministic: the browser and the CLI build the same
// map from the same seed.

import { hash, type Rng, seeded } from "../../lib/random.ts";

export type Tile =
  | "wall"
  | "floor"
  | "stairs"
  | "gold"
  | "monster"
  | `key:${KeyColor}`
  | `door:${KeyColor}`;

export const KEY_COLORS = ["gold", "red"] as const;
export type KeyColor = (typeof KEY_COLORS)[number];

export interface Pos {
  row: number;
  col: number;
}

export interface UndercroftMap {
  rows: number;
  cols: number;
  /** tiles[row][col]; the hero is not a tile. */
  tiles: Tile[][];
  start: Pos;
  stairs: Pos;
  /** Hit points the hero starts with. */
  hp: number;
}

export type Direction = "north" | "east" | "south" | "west";
export const DIRECTIONS: Direction[] = ["north", "east", "south", "west"];
export const STEP: Record<Direction, Pos> = {
  north: { row: -1, col: 0 },
  east: { row: 0, col: 1 },
  south: { row: 1, col: 0 },
  west: { row: 0, col: -1 },
};

export const at = (m: UndercroftMap, p: Pos): Tile =>
  m.tiles[p.row]?.[p.col] ?? "wall";
export const moved = (p: Pos, d: Direction): Pos => ({
  row: p.row + STEP[d].row,
  col: p.col + STEP[d].col,
});
const same = (a: Pos, b: Pos) => a.row === b.row && a.col === b.col;
const keyOf = (p: Pos) => `${p.row},${p.col}`;

/** Whether a tile is beside (north, east, south, or west of) a monster. */
export function nearMonster(m: UndercroftMap, p: Pos): boolean {
  return DIRECTIONS.some((d) => at(m, moved(p, d)) === "monster");
}

/** What blocks a move: walls, monsters, and doors whose key is not held. */
export function blocked(tile: Tile, keys: ReadonlySet<KeyColor>): boolean {
  if (tile === "wall" || tile === "monster") return true;
  if (tile.startsWith("door:")) return !keys.has(tile.slice(5) as KeyColor);
  return false;
}

export interface PathOptions {
  /** Never step beside a monster. */
  safe?: boolean;
  /** Tiles to treat as open floor (unseen tiles, for a planner under fog). */
  open?: (p: Pos) => boolean;
  /** The goal: the stairs unless given. */
  goal?: (p: Pos) => boolean;
}

/**
 * The fewest moves from `from` holding `keys` to the goal, by breadth-first
 * search over (position, keys held); the moves, or null when unreachable.
 * Directions are tried north, east, south, west, so ties break alike
 * everywhere.
 */
export function shortestPath(
  m: UndercroftMap,
  from: Pos,
  keys: readonly KeyColor[] = [],
  options: PathOptions = {},
): Direction[] | null {
  const goal = options.goal ?? ((p: Pos) => same(p, m.stairs));
  const mask = (held: ReadonlySet<KeyColor>) =>
    KEY_COLORS.reduce((n, c, i) => (held.has(c) ? n | (1 << i) : n), 0);
  const start = { pos: from, keys: new Set(keys) };
  const seen = new Map<string, { prev: string | null; dir?: Direction }>();
  const id = (pos: Pos, held: ReadonlySet<KeyColor>) =>
    `${keyOf(pos)}|${mask(held)}`;
  seen.set(id(start.pos, start.keys), { prev: null });
  let queue = [start];
  while (queue.length) {
    const next: typeof queue = [];
    for (const s of queue) {
      if (goal(s.pos)) {
        const path: Direction[] = [];
        let at2 = seen.get(id(s.pos, s.keys));
        while (at2?.dir && at2.prev) {
          path.unshift(at2.dir);
          at2 = seen.get(at2.prev);
        }
        return path;
      }
      for (const d of DIRECTIONS) {
        const p = moved(s.pos, d);
        const open = options.open?.(p) ?? false;
        const tile = open ? "floor" : at(m, p);
        if (blocked(tile, s.keys)) continue;
        if (options.safe && !open && nearMonster(m, p) && !goal(p)) continue;
        const held = tile.startsWith("key:")
          ? new Set([...s.keys, tile.slice(4) as KeyColor])
          : s.keys;
        const k = id(p, held);
        if (seen.has(k)) continue;
        seen.set(k, { prev: id(s.pos, s.keys), dir: d });
        next.push({ pos: p, keys: held });
      }
    }
    queue = next;
  }
  return null;
}

/** The optimum: the fewest moves to the stairs without a hit point lost. */
export function optimalMoves(m: UndercroftMap): number {
  const path = shortestPath(m, m.start, [], { safe: true });
  if (!path) throw new Error("an Undercroft map without a safe way out");
  return path.length;
}

// --- Building maps -------------------------------------------------------

export interface MapPlan {
  /** Odd, 9 to 15. */
  size: number;
  /** Walls knocked through after the maze is cut, as a share of cells. */
  loops: number;
  keys: number;
  monsters: number;
  gold: number;
}

function blank(size: number): Tile[][] {
  return Array.from({ length: size }, () =>
    Array.from({ length: size }, () => "wall" as Tile),
  );
}

/** A perfect maze over the odd cells, cut by a seeded depth-first walk. */
function maze(rng: Rng, size: number): Tile[][] {
  const tiles = blank(size);
  const set = (p: Pos, t: Tile) => {
    (tiles[p.row] as Tile[])[p.col] = t;
  };
  const start = { row: 1, col: 1 };
  set(start, "floor");
  const stack = [start];
  while (stack.length) {
    const cell = stack.at(-1) as Pos;
    const options = DIRECTIONS.filter((d) => {
      const n = {
        row: cell.row + STEP[d].row * 2,
        col: cell.col + STEP[d].col * 2,
      };
      return (
        n.row > 0 &&
        n.col > 0 &&
        n.row < size - 1 &&
        n.col < size - 1 &&
        tiles[n.row]?.[n.col] === "wall"
      );
    });
    if (!options.length) {
      stack.pop();
      continue;
    }
    const d = options[Math.floor(rng() * options.length)] as Direction;
    set(moved(cell, d), "floor");
    const n = {
      row: cell.row + STEP[d].row * 2,
      col: cell.col + STEP[d].col * 2,
    };
    set(n, "floor");
    stack.push(n);
  }
  return tiles;
}

/** Knocks through walls that separate two floor tiles in a line, opening loops. */
function knockThrough(rng: Rng, tiles: Tile[][], count: number): void {
  const size = tiles.length;
  const candidates: Pos[] = [];
  for (let r = 1; r < size - 1; r++)
    for (let c = 1; c < size - 1; c++) {
      if (tiles[r]?.[c] !== "wall") continue;
      const ns = tiles[r - 1]?.[c] !== "wall" && tiles[r + 1]?.[c] !== "wall";
      const ew = tiles[r]?.[c - 1] !== "wall" && tiles[r]?.[c + 1] !== "wall";
      if (ns !== ew) candidates.push({ row: r, col: c });
    }
  for (let i = 0; i < count && candidates.length; i++) {
    const [p] = candidates.splice(Math.floor(rng() * candidates.length), 1);
    if (p) (tiles[p.row] as Tile[])[p.col] = "floor";
  }
}

/** Distances in moves from `from` over open tiles, ignoring keys and doors. */
function distances(tiles: Tile[][], from: Pos): Map<string, number> {
  const dist = new Map([[keyOf(from), 0]]);
  let queue = [from];
  while (queue.length) {
    const next: Pos[] = [];
    for (const p of queue)
      for (const d of DIRECTIONS) {
        const n = moved(p, d);
        if ((tiles[n.row]?.[n.col] ?? "wall") === "wall") continue;
        if (dist.has(keyOf(n))) continue;
        dist.set(keyOf(n), (dist.get(keyOf(p)) as number) + 1);
        next.push(n);
      }
    queue = next;
  }
  return dist;
}

const floorTiles = (tiles: Tile[][]): Pos[] =>
  tiles.flatMap((row, r) =>
    row.flatMap((t, c) => (t === "floor" ? [{ row: r, col: c }] : [])),
  );

/** The tiles a path visits, the start included. */
function visited(from: Pos, path: Direction[]): Pos[] {
  const out = [from];
  for (const d of path) out.push(moved(out.at(-1) as Pos, d));
  return out;
}

/**
 * Doors on the way out, in order, each with its key off the way, before
 * that door: the tree maze has no way round a door, so every key is needed
 * in turn.
 */
function placeKeys(rng: Rng, m: UndercroftMap, count: number): void {
  const set = (p: Pos, t: Tile) => {
    (m.tiles[p.row] as Tile[])[p.col] = t;
  };
  const way = visited(m.start, shortestPath(m, m.start) ?? []);
  const onWay = new Set(way.map(keyOf));
  // Doors sit in corridor tiles (one coordinate even), spread along the way.
  const corridors = way
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => (p.row % 2 === 0 || p.col % 2 === 0) && i > 2);
  for (let k = 0; k < count; k++) {
    const color = KEY_COLORS[k] as KeyColor;
    const target = ((k + 1) * way.length) / (count + 1);
    const door = corridors.reduce((best, c) =>
      Math.abs(c.i - target) < Math.abs(best.i - target) ? c : best,
    ).p;
    // Where the hero can walk before this door, the earlier doors open.
    const reach = new Set<string>();
    let queue = [m.start];
    reach.add(keyOf(m.start));
    while (queue.length) {
      const next: Pos[] = [];
      for (const p of queue)
        for (const d of DIRECTIONS) {
          const n = moved(p, d);
          const t = at(m, n);
          if (t === "wall" || same(n, door) || t === `door:${color}`) continue;
          if (reach.has(keyOf(n))) continue;
          reach.add(keyOf(n));
          next.push(n);
        }
      queue = next;
    }
    const dist = distances(m.tiles, door);
    const spots = floorTiles(m.tiles).filter(
      (p) => reach.has(keyOf(p)) && !onWay.has(keyOf(p)),
    );
    const pool = spots.length
      ? spots
      : floorTiles(m.tiles).filter(
          (p) => reach.has(keyOf(p)) && !same(p, m.start),
        );
    // Among the far half of the reachable spots, a seeded one: a detour.
    pool.sort(
      (a, b) =>
        (dist.get(keyOf(b)) ?? 0) - (dist.get(keyOf(a)) ?? 0) ||
        keyOf(a).localeCompare(keyOf(b)),
    );
    const far = pool.slice(0, Math.max(1, Math.ceil(pool.length / 2)));
    const key = far[Math.floor(rng() * far.length)] as Pos;
    set(door, `door:${color}`);
    set(key, `key:${color}`);
  }
}

/**
 * Monsters beside the safe way out, each where it lengthens the safe
 * optimum most (a seeded pick among equals), and only where a safe way
 * round remains: the optimum walks round them.
 */
function placeMonsters(rng: Rng, m: UndercroftMap, count: number): void {
  const safeLength = () =>
    shortestPath(m, m.start, [], { safe: true })?.length ?? null;
  for (let placed = 0; placed < count; placed++) {
    const base = safeLength() ?? 0;
    const way = visited(
      m.start,
      shortestPath(m, m.start, [], { safe: true }) ?? [],
    );
    const candidates = floorTiles(m.tiles).filter(
      (p) =>
        way.some(
          (w) => Math.abs(w.row - p.row) + Math.abs(w.col - p.col) <= 1,
        ) &&
        Math.abs(p.row - m.start.row) + Math.abs(p.col - m.start.col) > 2 &&
        Math.abs(p.row - m.stairs.row) + Math.abs(p.col - m.stairs.col) > 2,
    );
    let best: Pos[] = [];
    let gain = -1;
    for (const p of candidates) {
      (m.tiles[p.row] as Tile[])[p.col] = "monster";
      const length = safeLength();
      (m.tiles[p.row] as Tile[])[p.col] = "floor";
      if (length === null) continue;
      if (length - base > gain) {
        gain = length - base;
        best = [p];
      } else if (length - base === gain) best.push(p);
    }
    const p = best[Math.floor(rng() * best.length)];
    if (!p) return;
    (m.tiles[p.row] as Tile[])[p.col] = "monster";
  }
}

/** Gold in seeded dead ends and corners off the way out. */
function placeGold(rng: Rng, m: UndercroftMap, count: number): void {
  const way = new Set(
    visited(m.start, shortestPath(m, m.start, [], { safe: true }) ?? []).map(
      keyOf,
    ),
  );
  const spots = floorTiles(m.tiles).filter(
    (p) => !way.has(keyOf(p)) && !nearMonster(m, p),
  );
  for (let i = 0; i < count && spots.length; i++) {
    const [p] = spots.splice(Math.floor(rng() * spots.length), 1);
    if (p) (m.tiles[p.row] as Tile[])[p.col] = "gold";
  }
}

/** A map from `plan`, the same for the same seed and name. */
export function buildMap(
  name: string,
  seed: number,
  plan: MapPlan,
): UndercroftMap {
  const rng = seeded(hash(`undercroft:${name}`, seed));
  const tiles = maze(rng, plan.size);
  knockThrough(rng, tiles, Math.round(plan.loops * ((plan.size - 1) / 2) ** 2));
  const start = { row: 1, col: 1 };
  // The stairs: the floor tile farthest from the start.
  const dist = distances(tiles, start);
  let stairs = start;
  for (const p of floorTiles(tiles))
    if ((dist.get(keyOf(p)) ?? 0) > (dist.get(keyOf(stairs)) ?? 0)) stairs = p;
  (tiles[stairs.row] as Tile[])[stairs.col] = "stairs";
  const m: UndercroftMap = {
    rows: plan.size,
    cols: plan.size,
    tiles,
    start,
    stairs,
    hp: 3,
  };
  placeKeys(rng, m, plan.keys);
  placeMonsters(rng, m, plan.monsters);
  placeGold(rng, m, plan.gold);
  return m;
}

/** The map as text, one row a line: the symbols the request's legend names. */
export const SYMBOL: Record<Tile, string> = {
  wall: "#",
  floor: ".",
  stairs: ">",
  gold: "$",
  monster: "M",
  "key:gold": "a",
  "door:gold": "A",
  "key:red": "b",
  "door:red": "B",
};
