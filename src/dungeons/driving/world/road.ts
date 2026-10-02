// The asphalt as convex polygons, and what a car's body has to do with it:
// how much of it is off the road, how far the road is, where its edges lie
// ahead. Candidate paths are judged against these same polygons.

import {
  clamp,
  dist,
  heading,
  move,
  nearestOnPath,
  type Point,
  type Pose,
  pointAt,
  round,
} from "./geometry.ts";
import type { World } from "./types.ts";
import { type OnRoute, routeSection } from "./world.ts";

export interface Surface {
  points: Point[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** A body on the ground: a rectangle `width` across and `depth` long. */
export interface Footprint extends Pose {
  width: number;
  depth: number;
}

const cache = new WeakMap<World, Surface[]>();

const cross = (a: Point, b: Point, p: Point) =>
  (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);

const area = (p: Point[]) =>
  Math.abs(
    p.reduce((a, v, i) => {
      const w = p[(i + 1) % p.length] as Point;
      return a + v.x * w.z - w.x * v.z;
    }, 0),
  ) / 2;

/** Orients the points counter-clockwise (in x/z) and records the bounding box. */
function polygon(points: Point[]): Surface {
  const signed = points.reduce((a, p, i) => {
    const q = points[(i + 1) % points.length] as Point;
    return a + p.x * q.z - q.x * p.z;
  }, 0);
  if (signed < 0) points.reverse();
  return {
    points,
    minX: Math.min(...points.map((p) => p.x)),
    maxX: Math.max(...points.map((p) => p.x)),
    minZ: Math.min(...points.map((p) => p.z)),
    maxZ: Math.max(...points.map((p) => p.z)),
  };
}

export function footprint(car: Footprint, padding = 0): Point[] {
  return polygon(
    (
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const
    ).map(([right, ahead]) =>
      move(
        move(car, car.heading, ahead * (car.depth / 2 + padding)),
        car.heading + Math.PI / 2,
        right * (car.width / 2 + padding),
      ),
    ),
  ).points;
}

/** Every road surface of the world, built once per world. */
export function roadGeometry(world: World): Surface[] {
  const cached = cache.get(world);
  if (cached) return cached;
  const surfaces: Surface[] = [];
  if (world.type === "highway") {
    // The two carriageways as rendered, leaving out the 2.1 m median.
    const samples = world.roadSamples ?? [];
    const offset = (i: number, d: number) =>
      move(
        samples[i] as Point,
        heading(
          samples[Math.max(0, i - 1)] as Point,
          samples[Math.min(samples.length - 1, i + 1)] as Point,
        ) +
          Math.PI / 2,
        d,
      );
    for (let i = 0; i < samples.length - 1; i++) {
      for (const [left, right] of [
        [-12.5, -1.05],
        [1.05, 12.5],
      ] as const) {
        surfaces.push(
          polygon([
            offset(i, left),
            offset(i, right),
            offset(i + 1, right),
            offset(i + 1, left),
          ]),
        );
      }
    }
  } else {
    for (const edge of world.edges) {
      const a = world.byId[edge.a] as Point;
      const b = world.byId[edge.b] as Point;
      const h = heading(a, b);
      surfaces.push(
        polygon([
          move(a, h - Math.PI / 2, edge.width / 2),
          move(a, h + Math.PI / 2, edge.width / 2),
          move(b, h + Math.PI / 2, edge.width / 2),
          move(b, h - Math.PI / 2, edge.width / 2),
        ]),
      );
    }
    for (const n of world.nodes)
      surfaces.push(
        polygon([
          { x: n.x - 6.05, z: n.z - 6.05 },
          { x: n.x + 6.05, z: n.z - 6.05 },
          { x: n.x + 6.05, z: n.z + 6.05 },
          { x: n.x - 6.05, z: n.z + 6.05 },
        ]),
      );
  }
  for (const road of world.connectorRoads ?? []) {
    const offset = (i: number, side: number) =>
      move(
        road.points[i] as Point,
        heading(
          road.points[Math.max(0, i - 1)] as Point,
          road.points[Math.min(road.points.length - 1, i + 1)] as Point,
        ) +
          Math.PI / 2,
        (side * road.width) / 2,
      );
    for (let i = 0; i < road.points.length - 1; i++)
      surfaces.push(
        polygon([
          offset(i, -1),
          offset(i, 1),
          offset(i + 1, 1),
          offset(i + 1, -1),
        ]),
      );
  }
  cache.set(world, surfaces);
  return surfaces;
}

function boxDistance(p: Point, box: Surface): number {
  return Math.hypot(
    Math.max(box.minX - p.x, 0, p.x - box.maxX),
    Math.max(box.minZ - p.z, 0, p.z - box.maxZ),
  );
}

/** The surfaces within `radius` of the car, or the single nearest when none is. */
export function localRoads(world: World, car: Point, radius = 100): Surface[] {
  const all = roadGeometry(world);
  const nearby = all.filter((p) => boxDistance(car, p) <= radius);
  return nearby.length
    ? nearby
    : [
        all.reduce((a, b) =>
          boxDistance(car, a) < boxDistance(car, b) ? a : b,
        ),
      ];
}

function halfPlane(
  points: Point[],
  a: Point,
  b: Point,
  inside: boolean,
): Point[] {
  const result: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Point;
    const q = points[(i + 1) % points.length] as Point;
    const dp = cross(a, b, p);
    const dq = cross(a, b, q);
    const pin = inside ? dp >= -1e-9 : dp <= 1e-9;
    const qin = inside ? dq >= -1e-9 : dq <= 1e-9;
    if (pin) result.push(p);
    if (pin !== qin) {
      const t = dp / (dp - dq);
      result.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
    }
  }
  return result;
}

/** The parts of a convex polygon outside a convex clip polygon. */
function subtract(subject: Point[], clip: Point[]): Point[][] {
  const outside: Point[][] = [];
  let inside = subject;
  for (let i = 0; i < clip.length && inside.length; i++) {
    const a = clip[i] as Point;
    const b = clip[(i + 1) % clip.length] as Point;
    const piece = halfPlane(inside, a, b, false);
    if (piece.length >= 3 && area(piece) > 1e-7) outside.push(piece);
    inside = halfPlane(inside, a, b, true);
  }
  return outside;
}

export function distanceToRoad(point: Point, surfaces: Surface[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const { points } of surfaces) {
    if (
      points.every(
        (p, i) =>
          cross(p, points[(i + 1) % points.length] as Point, point) >= -1e-8,
      )
    )
      return 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i] as Point;
      const b = points[(i + 1) % points.length] as Point;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const t = clamp(
        ((point.x - a.x) * dx + (point.z - a.z) * dz) /
          (dx * dx + dz * dz || 1),
        0,
        1,
      );
      best = Math.min(best, dist(point, { x: a.x + dx * t, z: a.z + dz * t }));
    }
  }
  return best;
}

export interface Occupancy {
  on_road: boolean;
  /** Share of the body's area off the asphalt. */
  outside_fraction: number;
}

export function roadOccupancy(car: Footprint, surfaces: Surface[]): Occupancy {
  const body = polygon(footprint(car));
  let remaining = [body.points];
  for (const surface of surfaces) {
    if (
      surface.maxX < body.minX ||
      surface.minX > body.maxX ||
      surface.maxZ < body.minZ ||
      surface.minZ > body.maxZ
    )
      continue;
    remaining = remaining.flatMap((p) => subtract(p, surface.points));
    if (!remaining.length) break;
  }
  const fraction = Math.min(
    1,
    remaining.reduce((sum, p) => sum + area(p), 0) / (car.width * car.depth),
  );
  return { on_road: fraction < 1e-5, outside_fraction: fraction };
}

export interface Relative {
  right_m: number;
  ahead_m: number;
}

/** A point in the car's frame: meters to its right and ahead of its center. */
export function relativePoint(
  car: Pose,
  point: Point,
  precision = 1,
): Relative {
  const dx = point.x - car.x;
  const dz = point.z - car.z;
  return {
    right_m: round(
      dx * Math.cos(car.heading) + dz * Math.sin(car.heading),
      precision,
    ),
    ahead_m: round(
      dx * Math.sin(car.heading) - dz * Math.cos(car.heading),
      precision,
    ),
  };
}

interface Interval {
  left: number;
  right: number;
}

/**
 * The asphalt across a line through `center` at heading `h`: the polygons'
 * intervals, touching ones joined, so internal mesh edges are not road edges
 * and a median keeps two carriageways apart. On the road the interval under
 * the center; off it, the nearest, so signed clearances point back.
 */
function roadCrossSection(
  center: Point,
  h: number,
  surfaces: Surface[],
): Interval | null {
  const direction = { x: Math.cos(h), z: Math.sin(h) };
  const intervals: Interval[] = [];
  for (const { points } of surfaces) {
    let left = Number.NEGATIVE_INFINITY;
    let right = Number.POSITIVE_INFINITY;
    for (let i = 0; i < points.length; i++) {
      const a = points[i] as Point;
      const b = points[(i + 1) % points.length] as Point;
      const origin = cross(a, b, center);
      const slope = (b.x - a.x) * direction.z - (b.z - a.z) * direction.x;
      if (Math.abs(slope) < 1e-10) {
        if (origin < -1e-8) {
          left = Number.POSITIVE_INFINITY;
          break;
        }
      } else if (slope > 0) left = Math.max(left, -origin / slope);
      else right = Math.min(right, -origin / slope);
      if (left > right) break;
    }
    if (Number.isFinite(left) && Number.isFinite(right) && left <= right)
      intervals.push({ left, right });
  }
  intervals.sort((a, b) => a.left - b.left);
  const joined: Interval[] = [];
  for (const interval of intervals) {
    const end = joined[joined.length - 1];
    if (end && interval.left <= end.right + 1e-6)
      end.right = Math.max(end.right, interval.right);
    else joined.push({ ...interval });
  }
  const distance = (interval: Interval) =>
    Math.max(interval.left, -interval.right, 0);
  return joined.reduce<Interval | null>(
    (best, interval) =>
      !best || distance(interval) < distance(best) ? interval : best,
    null,
  );
}

export interface BoundarySample {
  route_ahead_m: number;
  center: [number, number];
  road_left: [number, number] | null;
  road_right: [number, number] | null;
  lane_left: [number, number];
  lane_right: [number, number];
  center_on_road: boolean;
}

export interface ClearanceSample {
  ahead_m: number;
  road_left_m: number | null;
  road_right_m: number | null;
  left_clearance_m: number | null;
  right_clearance_m: number | null;
}

export interface RoadState extends Occupancy {
  distance_to_road_m: number;
  coordinates: string;
  boundary_source: string;
  polygon_clip_radius_m: number;
  preview_distance_m: number;
  ego_footprint: [number, number][];
  edge_clearance_samples: ClearanceSample[];
  boundary_samples: BoundarySample[];
  drivable_polygons: [number, number][][];
}

export interface RoadCar extends Footprint, OnRoute {
  speed: number;
}

/** What a decider is told about the road: occupancy, edges ahead, clearances. */
export function roadState(
  car: RoadCar,
  surfaces: Surface[],
  lookaheadM = 40,
): RoadState {
  const relative = (p: Point): [number, number] => {
    const { right_m, ahead_m } = relativePoint(car, p, 2);
    return [right_m, ahead_m];
  };
  const near = nearestOnPath(car, car.route.points);
  const preview = Math.max(40, lookaheadM);
  const stations = new Set(
    [
      -car.depth,
      0,
      ...Array.from({ length: 12 }, (_, i) => ((i + 1) * preview) / 12),
    ].map((ahead) => clamp(near.s + ahead, 0, car.route.length)),
  );
  const boundaries = [...stations].map((s): BoundarySample => {
    const center = pointAt(car.route.points, s);
    const h = center.heading ?? nearestOnPath(center, car.route.points).heading;
    const section = roadCrossSection(center, h, surfaces);
    const halfWidth = routeSection(car, s)?.laneHalfWidth ?? 3;
    const atOffset = (offset: number) =>
      relative(move(center, h + Math.PI / 2, offset));
    return {
      route_ahead_m: round(s - near.s, 1),
      center: relative(center),
      road_left: section ? atOffset(section.left) : null,
      road_right: section ? atOffset(section.right) : null,
      lane_left: atOffset(-halfWidth),
      lane_right: atOffset(halfWidth),
      center_on_road: !!section && section.left <= 0 && section.right >= 0,
    };
  });
  const clearances = [-car.depth / 2, 0, car.depth / 2].map(
    (ahead): ClearanceSample => {
      const center = move(car, car.heading, ahead);
      const section = roadCrossSection(center, car.heading, surfaces);
      return {
        ahead_m: round(ahead, 2),
        road_left_m: section ? round(section.left, 2) : null,
        road_right_m: section ? round(section.right, 2) : null,
        left_clearance_m: section
          ? round(-car.width / 2 - section.left, 2)
          : null,
        right_clearance_m: section
          ? round(section.right - car.width / 2, 2)
          : null,
      };
    },
  );
  // Clip to a local square so long streets do not bloat the state.
  const radius = Math.max(
    preview + near.distance + car.depth,
    Math.min(
      160,
      Math.max(
        Math.abs(car.speed) * 3 + 10,
        distanceToRoad(car, surfaces) + 15,
      ),
    ),
  );
  const window = polygon([
    { x: car.x - radius, z: car.z - radius },
    { x: car.x + radius, z: car.z - radius },
    { x: car.x + radius, z: car.z + radius },
    { x: car.x - radius, z: car.z + radius },
  ]).points;
  const polygons = surfaces.flatMap((surface) => {
    let clipped = surface.points;
    for (let i = 0; i < window.length && clipped.length; i++)
      clipped = halfPlane(
        clipped,
        window[i] as Point,
        window[(i + 1) % window.length] as Point,
        true,
      );
    return clipped.length >= 3 && area(clipped) > 0.01
      ? [
          clipped.map((p): [number, number] => {
            const { right_m, ahead_m } = relativePoint(car, p);
            return [right_m, ahead_m];
          }),
        ]
      : [];
  });
  return {
    ...roadOccupancy(car, surfaces),
    distance_to_road_m: round(distanceToRoad(car, surfaces), 1),
    coordinates:
      "Points are [right, ahead] meters from the car center. Negative right is left; negative ahead is behind. Left/right edges follow the route direction.",
    boundary_source:
      "Actual asphalt geometry; excludes grass, sidewalks and median",
    polygon_clip_radius_m: round(radius, 1),
    preview_distance_m: round(
      Math.max(0, Math.min(preview, car.route.length - near.s)),
      1,
    ),
    ego_footprint: footprint(car).map(relative),
    edge_clearance_samples: clearances,
    boundary_samples: boundaries,
    drivable_polygons: polygons,
  };
}
