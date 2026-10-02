// Contact between oriented rectangles: their signed separation, and the
// first contact of two swept bodies between two poses.

import { angle, clamp, dist, mix, type Point } from "../world/geometry.ts";

/** An oriented rectangle, moving or not. */
export interface Shape extends Point {
  heading: number;
  width: number;
  depth: number;
  speed: number;
}

/** Anything with a footprint: buildings carry `rotation`, movers `heading`. */
export interface Placed extends Point {
  id: string;
  type: string;
  width: number;
  depth: number;
  heading?: number;
  rotation?: number;
  speed?: number;
}

export function collisionPose(object: Placed): Shape {
  return {
    x: object.x,
    z: object.z,
    heading:
      object.type === "building"
        ? -(object.rotation || 0)
        : object.heading || 0,
    width: object.width,
    depth: object.depth,
    speed: object.speed || 0,
  };
}

interface Axis extends Point {
  radius: number;
}

function axes(vehicle: Partial<Shape>): Axis[] {
  const sin = Math.sin(vehicle.heading || 0);
  const cos = Math.cos(vehicle.heading || 0);
  return [
    { x: sin, z: -cos, radius: (vehicle.depth || 4.2) / 2 },
    { x: cos, z: sin, radius: (vehicle.width || 1.9) / 2 },
  ];
}

/** Signed separation of two oriented footprints (separating axes); negative is overlap. */
export function footprintClearance(
  a: Point & Partial<Shape>,
  b: Point & Partial<Shape>,
): number {
  const aa = axes(a);
  const bb = axes(b);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let separation = Number.NEGATIVE_INFINITY;
  for (const axis of [...aa, ...bb]) {
    const radius = [...aa, ...bb].reduce(
      (sum, edge) =>
        sum + Math.abs(axis.x * edge.x + axis.z * edge.z) * edge.radius,
      0,
    );
    separation = Math.max(
      separation,
      Math.abs(dx * axis.x + dz * axis.z) - radius,
    );
  }
  return separation;
}

function interpolate(a: Shape, b: Shape, t: number): Shape {
  return {
    ...b,
    x: mix(a.x, b.x, t),
    z: mix(a.z, b.z, t),
    heading: a.heading + angle(b.heading - a.heading) * t,
  };
}

export interface Sweep<O extends Placed = Placed> {
  object: O;
  /** Where the object was at the start of the sweep; absent for a stationary or teleported one. */
  previous?: Shape | null | undefined;
}

export interface Hit<O extends Placed = Placed> {
  object: O;
  /** How far through the sweep contact happens, 0 to 1. */
  fraction: number;
  player: Shape;
  target: Shape;
  point: Point;
  normal: Point;
  relativeSpeed: number;
}

/**
 * The first contact while `start` moves to `end` and each obstacle moves
 * from its previous pose to its current one, rotation included, so thin or
 * crossing objects cannot slip between frames. Refined by bisection.
 */
export function firstCollision<O extends Placed>(
  start: Shape,
  end: Shape,
  obstacles: Sweep<O>[],
): Hit<O> | null {
  let first: Hit<O> | null = null;
  const radius = (p: Shape) => Math.hypot(p.width, p.depth) / 2;
  for (const { object, previous } of obstacles) {
    const b = collisionPose(object);
    const a = previous || b;
    const reach = radius(end) + radius(b);
    if (
      Math.min(start.x, end.x) - Math.max(a.x, b.x) > reach ||
      Math.min(a.x, b.x) - Math.max(start.x, end.x) > reach ||
      Math.min(start.z, end.z) - Math.max(a.z, b.z) > reach ||
      Math.min(a.z, b.z) - Math.max(start.z, end.z) > reach
    )
      continue;
    const travel =
      dist(start, end) +
      dist(a, b) +
      Math.abs(angle(end.heading - start.heading)) * radius(end) +
      Math.abs(angle(b.heading - a.heading)) * radius(b);
    const steps = Math.max(1, Math.ceil(travel / 0.12));
    const overlaps = (t: number) =>
      footprintClearance(interpolate(start, end, t), interpolate(a, b, t)) < 0;
    for (let i = 0; i <= steps; i++) {
      let high = i / steps;
      if (first && high - 1 / steps > first.fraction) break;
      if (!overlaps(high)) continue;
      let low = Math.max(0, (i - 1) / steps);
      for (let j = 0; j < 12 && high > low; j++) {
        const middle = (low + high) / 2;
        if (overlaps(middle)) high = middle;
        else low = middle;
      }
      if (!first || high < first.fraction) {
        const player = interpolate(start, end, low);
        const target = interpolate(a, b, low);
        const sin = Math.sin(target.heading);
        const cos = Math.cos(target.heading);
        const dx = player.x - target.x;
        const dz = player.z - target.z;
        const right = clamp(
          dx * cos + dz * sin,
          -target.width / 2,
          target.width / 2,
        );
        const forward = clamp(
          dx * sin - dz * cos,
          -target.depth / 2,
          target.depth / 2,
        );
        const point = {
          x: target.x + cos * right + sin * forward,
          z: target.z + sin * right - cos * forward,
        };
        const length = dist(player, point) || 1;
        const normal = {
          x: (player.x - point.x) / length,
          z: (player.z - point.z) / length,
        };
        const relativeSpeed = Math.hypot(
          Math.sin(end.heading) * end.speed - Math.sin(b.heading) * b.speed,
          -Math.cos(end.heading) * end.speed + Math.cos(b.heading) * b.speed,
        );
        first = {
          object,
          fraction: high,
          player,
          target,
          point,
          normal,
          relativeSpeed,
        };
      }
      break;
    }
  }
  return first;
}
