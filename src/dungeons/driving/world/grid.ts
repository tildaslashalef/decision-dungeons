// Town and city: a jittered grid of junctions, streets between them,
// blocks of buildings or parks, signals and stop signs. Every random draw
// happens in a fixed order, so a seed always builds the same world.

import { pick, seeded } from "../../../lib/random.ts";
import {
  dist,
  heading,
  last,
  move,
  type Point,
  samplePolyline,
} from "./geometry.ts";
import type {
  Building,
  Crossing,
  Junction,
  Road,
  Route,
  Theme,
  World,
  WorldObject,
} from "./types.ts";

export const THEMES: Record<"town" | "city" | "highway", Theme> = {
  city: {
    name: "Skyline City",
    subtitle: "Long avenues. A higher horizon.",
    size: 5,
    traffic: 28,
    buildings: 0.97,
    limit: 18,
  },
  town: {
    name: "Cedar Town",
    subtitle: "Room between the crossroads.",
    size: 5,
    traffic: 14,
    buildings: 0.62,
    limit: 14,
  },
  highway: {
    name: "Interstate 08",
    subtitle: "On-ramp, open road, small-town arrival.",
    size: 8,
    traffic: 18,
    buildings: 0,
    limit: 28,
    laneOffset: 9,
  },
};

const STREETS = [
  "Cedar",
  "Maple",
  "Willow",
  "Juniper",
  "Oak",
  "Birch",
  "Laurel",
];
const SUFFIXES = [" Street", " Avenue", " Way"];
const COLORS = [
  "#eadbc9",
  "#e6ad91",
  "#d9e2ce",
  "#e5c977",
  "#bdd3d0",
  "#ebd9ad",
];
const ROW_COLORS = ["#eadbc9", "#d9e2ce", "#e6ad91", "#bdd3d0", "#ebd9ad"];
const ROOFS = ["#697577", "#a26f58", "#536d65"];
const GLASS = ["#8aa4ac", "#829eaa", "#749699", "#a4bab9"];

/** A world object before it has an id. */
type Draft = WorldObject extends infer T
  ? T extends WorldObject
    ? Omit<T, "id">
    : never
  : never;

export function generateGrid(seed: number, type: "town" | "city"): World {
  const r = seeded(seed);
  const theme = THEMES[type];
  const n = theme.size;
  const city = type === "city";
  const xs = [0];
  const zs = [0];
  for (let i = 1; i < n; i++) {
    xs.push(last(xs) + (city ? 125 : 110) + Math.floor(r() * 55));
    zs.push(last(zs) + (city ? 125 : 110) + Math.floor(r() * 55));
  }
  const cx = last(xs) / 2;
  const cz = last(zs) / 2;
  xs.forEach((v, i) => {
    xs[i] = v - cx;
  });
  zs.forEach((v, i) => {
    zs[i] = v - cz;
  });
  const X = (i: number) => xs[i] as number;
  const Z = (j: number) => zs[j] as number;
  const nodes: Junction[] = [];
  const edges: Road[] = [];
  const objects: WorldObject[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++)
      nodes.push({
        id: `j${j}-${i}`,
        i,
        j,
        x: X(i),
        z: Z(j),
        control: (i + j) % 3 === 0 ? "stop" : "signal",
        offset: Math.floor(r() * 14),
        neighbors: [],
      });
  const node = (index: number) => nodes[index] as Junction;
  const link = (a: Junction, b: Junction) => {
    a.neighbors.push(b.id);
    b.neighbors.push(a.id);
    edges.push({
      id: `road-${edges.length}`,
      a: a.id,
      b: b.id,
      length: dist(a, b),
      width: 12,
      speedLimit: theme.limit,
      name: pick(r, STREETS) + pick(r, SUFFIXES),
    });
  };
  // Every east-west street and a north-south spine keep the grid connected;
  // the other north-south links vary with the seed.
  for (const p of nodes) {
    const i = p.i as number;
    const j = p.j as number;
    if (i < n - 1) link(p, node(j * n + i + 1));
    if (j < n - 1 && (i === 2 || (i === 1 && j === 1) || r() > 0.16))
      link(p, node((j + 1) * n + i));
  }
  let id = 0;
  const add = (draft: Draft) => {
    objects.push({ ...draft, id: `${draft.type}-${id++}` } as WorldObject);
  };
  const building = (
    x: number,
    z: number,
    style: Building["style"],
    height: number,
    color: string,
    rotation: number,
    width: number,
    depth: number,
  ) =>
    add({
      type: "building",
      x,
      z,
      style,
      width,
      depth,
      height,
      color,
      roof: pick(r, ROOFS),
      rotation,
    });
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const x = (X(i) + X(i + 1)) / 2;
      const z = (Z(j) + Z(j + 1)) / 2;
      const w = X(i + 1) - X(i);
      const d = Z(j + 1) - Z(j);
      const park = r() > theme.buildings;
      add({ type: "parcel", x, z, width: w - 17, depth: d - 17, park });
      for (const dx of [-1, 1])
        for (const dz of [-1, 1]) {
          const bx = x + dx * (w / 2 - 17);
          const bz = z + dz * (d / 2 - 17);
          if (!park) {
            const style: Building["style"] = city
              ? pick(r, [
                  "skyscraper",
                  "skyscraper",
                  "apartment",
                  "shop",
                ] as const)
              : pick(r, ["cottage", "cottage", "modern", "townhouse"] as const);
            // Draw order as in the reference: width, depth, height, color, roof.
            const width = (city ? 16 : 10) + r() * 2;
            const depth = (city ? 16 : 10) + r() * 2;
            const height =
              style === "skyscraper"
                ? 34 + r() * 58
                : style === "apartment"
                  ? 18 + r() * 12
                  : style === "townhouse"
                    ? 8
                    : 4 + r() * 2;
            const color = pick(r, COLORS);
            building(
              bx,
              bz,
              style,
              height,
              color,
              dz < 0 ? Math.PI : 0,
              width,
              depth,
            );
          } else
            add({
              type: "tree",
              x: bx,
              z: bz,
              height: 5 + r() * 4,
              kind: r() > 0.4 ? "round" : "pine",
            });
        }
      if (!park) {
        for (const axis of ["x", "z"] as const) {
          const length = axis === "x" ? w : d;
          for (let t = -length / 2 + 39; t < length / 2 - 28; t += 24) {
            for (const side of [-1, 1]) {
              const bx = axis === "x" ? x + t : x + side * (w / 2 - 17);
              const bz = axis === "z" ? z + t : z + side * (d / 2 - 17);
              const style: Building["style"] = city
                ? pick(r, ["skyscraper", "skyscraper", "apartment"] as const)
                : pick(r, ["cottage", "modern"] as const);
              const width = (city ? 16 : 10) + r() * 2;
              const depth = (city ? 16 : 10) + r() * 2;
              const height =
                style === "skyscraper"
                  ? 32 + r() * 65
                  : style === "apartment"
                    ? 18 + r() * 12
                    : 5 + r() * 3;
              const color = pick(r, ROW_COLORS);
              const rotation =
                axis === "x"
                  ? side < 0
                    ? Math.PI
                    : 0
                  : side < 0
                    ? -Math.PI / 2
                    : Math.PI / 2;
              building(bx, bz, style, height, color, rotation, width, depth);
            }
          }
        }
      }
      for (let k = 0; k < (park ? 22 : 12); k++) {
        const tx = x + (r() - 0.5) * (w - 22);
        const tz = z + (r() - 0.5) * (d - 22);
        add({
          type: "tree",
          x: tx,
          z: tz,
          height: 4 + r() * 5,
          kind: r() > 0.3 ? "round" : "pine",
        });
      }
      if (park) add({ type: "bench", x, z, rotation: 0 });
    }
  // A tree-lined outer boundary.
  for (let k = 0; k < 65; k++) {
    const side = k % 4;
    const x =
      side < 2
        ? side === 0
          ? X(0) - 17
          : last(xs) + 17
        : X(0) + r() * (last(xs) - X(0));
    const z =
      side >= 2
        ? side === 2
          ? Z(0) - 17
          : last(zs) + 17
        : Z(0) + r() * (last(zs) - Z(0));
    const height = 5 + r() * 7;
    add({
      type: "tree",
      x,
      z,
      height,
      kind: pick(r, ["round", "pine"] as const),
    });
  }
  const byId = Object.fromEntries(nodes.map((v) => [v.id, v]));
  for (const junction of nodes)
    for (const nid of junction.neighbors) {
      const other = byId[nid] as Junction;
      const h = heading(other, junction);
      const p = move(move(junction, h, -9), h + Math.PI / 2, 6.9);
      add({
        type: junction.control === "stop" ? "stop_sign" : "traffic_light",
        x: p.x,
        z: p.z,
        nodeId: junction.id,
        approach: h,
        height: junction.control === "stop" ? 2.8 : 4.8,
      });
    }
  const startNode = node(n + 1);
  const nextNode = node(2 * n + 1);
  // A destination on the far half of the graph, always reachable.
  const destination = pick(
    r,
    nodes.filter(
      (p) =>
        (p.i as number) >= n - 2 &&
        (p.j as number) >= 1 &&
        (p.j as number) < n - 1,
    ),
  );
  objects
    .filter(
      (o): o is Building => o.type === "building" && o.style === "skyscraper",
    )
    .forEach((o, i) => {
      o.color = GLASS[i % GLASS.length] as string;
    });
  const buildings = objects.filter((o): o is Building => o.type === "building");
  const clearObjects = objects.filter(
    (o) =>
      o.type !== "tree" ||
      !buildings.some(
        (b) =>
          Math.abs(o.x - b.x) < b.width / 2 + 1.8 &&
          Math.abs(o.z - b.z) < b.depth / 2 + 1.8,
      ),
  );
  const world: World = {
    seed,
    type,
    theme,
    nodes,
    byId,
    edges,
    objects: clearObjects,
    xs,
    zs,
    bounds: {
      minX: X(0) - 28,
      maxX: last(xs) + 28,
      minZ: Z(0) - 28,
      maxZ: last(zs) + 28,
    },
    startNode: startNode.id,
    nextNode: nextNode.id,
    destination: destination.id,
    // Replaced just below, once the world exists to route over.
    route: { ids: [], points: [], crossings: [], length: 0 },
  };
  world.route = gridRoute(world, [
    startNode.id,
    ...shortestPath(world, nextNode.id, destination.id, startNode.id),
  ]);
  return world;
}

/**
 * Dijkstra over the junctions. Leaving `start` back toward `previousNode`
 * is not allowed, so a new trip never begins with a U-turn.
 */
export function shortestPath(
  world: World,
  start: string,
  end: string,
  previousNode: string | null = null,
): string[] {
  const cost: Record<string, number> = { [start]: 0 };
  const prev: Record<string, string> = {};
  const todo = new Set(world.nodes.map((p) => p.id));
  while (todo.size) {
    let u: string | undefined;
    for (const id of todo)
      if (
        u === undefined ||
        (cost[id] ?? Number.POSITIVE_INFINITY) <
          (cost[u] ?? Number.POSITIVE_INFINITY)
      )
        u = id;
    if (u === undefined || u === end) break;
    todo.delete(u);
    const from = world.byId[u] as Junction;
    for (const v of from.neighbors) {
      if (u === start && v === previousNode) continue;
      const c = (cost[u] as number) + dist(from, world.byId[v] as Junction);
      if (c < (cost[v] ?? Number.POSITIVE_INFINITY)) {
        cost[v] = c;
        prev[v] = u;
      }
    }
  }
  const route = [end];
  while (route[0] !== start) {
    const before = prev[route[0] as string];
    if (!before) throw new Error("Unreachable destination");
    route.unshift(before);
  }
  return route;
}

/** The right-hand lane through a list of grid junctions, with its turns and stop lines. */
export function gridRoute(world: World, ids: string[]): Route {
  const raw: Point[] = [];
  const crossings: Omit<Crossing, "stopS">[] = [];
  const nodes = ids.map((id) => world.byId[id] as Junction);
  const nodeAt = (i: number) => nodes[i] as Junction;
  const offset = (p: Point, h: number) => move(p, h + Math.PI / 2, 3);
  for (let i = 0; i < nodes.length; i++) {
    const p = nodeAt(i);
    const hin = heading(nodeAt(Math.max(0, i - 1)), nodeAt(i === 0 ? 1 : i));
    const hout = i < nodes.length - 1 ? heading(p, nodeAt(i + 1)) : hin;
    if (i === 0) {
      raw.push(move(offset(p, hout), hout, 14));
      continue;
    }
    if (i === nodes.length - 1) {
      raw.push(move(offset(p, hin), hin, -15));
      continue;
    }
    const a = move(offset(p, hin), hin, -11);
    const b = move(offset(p, hout), hout, 11);
    raw.push(a);
    if (Math.cos(hout - hin) < -0.99) {
      // A dead end: a continuous U-turn into the opposite lane.
      const center = move(p, hin, -11);
      for (let k = 1; k <= 24; k++) {
        const theta = (k / 24) * Math.PI;
        raw.push(
          move(
            move(center, hin, Math.sin(theta) * 3),
            hin + Math.PI / 2,
            Math.cos(theta) * 3,
          ),
        );
      }
    } else if (Math.abs(Math.sin(hout - hin)) < 0.1) {
      raw.push(b);
    } else {
      // The two right-hand lane lines meet at the quadratic's control point.
      const c =
        Math.abs(Math.sin(hin)) > 0.5 ? { x: b.x, z: a.z } : { x: a.x, z: b.z };
      for (let k = 1; k <= 16; k++) {
        const t = k / 16;
        const u = 1 - t;
        raw.push({
          x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
          z: u * u * a.z + 2 * u * t * c.z + t * t * b.z,
        });
      }
    }
    crossings.push({ nodeId: p.id, x: p.x, z: p.z, approach: hin, exit: hout });
  }
  const points = samplePolyline(raw);
  const withStops: Crossing[] = crossings.map((c) => {
    const target = move(offset(c, c.approach), c.approach, -10.5);
    let best = Number.POSITIVE_INFINITY;
    let stopS = 0;
    for (const p of points) {
      const d = dist(p, target);
      if (d < best) {
        best = d;
        stopS = p.s;
      }
    }
    return { ...c, stopS };
  });
  return { ids, points, crossings: withStops, length: last(points).s };
}

export interface SignalState {
  color: "red" | "amber" | "green";
  walk: boolean;
  remaining: number;
}

/**
 * A 24 s cycle: north-south green 0–8, amber 8–10; east-west green 10–18,
 * amber 18–20; all red with walk 20–24.
 */
export function signalState(
  node: Junction,
  time: number,
  approach: number,
): SignalState {
  const phase = (time + node.offset) % 24;
  const ns = Math.abs(Math.cos(approach)) > 0.5;
  if (phase >= 20) return { color: "red", walk: true, remaining: 24 - phase };
  if (ns)
    return {
      color: phase < 8 ? "green" : phase < 10 ? "amber" : "red",
      walk: false,
      remaining: phase < 8 ? 8 - phase : phase < 10 ? 10 - phase : 24 - phase,
    };
  return {
    color: phase >= 10 && phase < 18 ? "green" : phase >= 18 ? "amber" : "red",
    walk: false,
    remaining: phase < 10 ? 10 - phase : phase < 18 ? 18 - phase : 20 - phase,
  };
}
