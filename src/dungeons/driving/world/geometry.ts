// Plane geometry on the world's x (east) and z (south) axes. Heading 0 is
// north (−z) and grows clockwise. Every simulation number passes through
// here, so operation order matters: the port reproduces the reference simulator's runs
// bit for bit, and a reordered sum would not.

export interface Point {
  x: number;
  z: number;
}

/** A point on a polyline, `s` meters from its start. */
export interface PathPoint extends Point {
  s: number;
  heading?: number;
}

export interface Pose extends Point {
  heading: number;
}

export const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v));
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Rounds as JSON-facing values are rounded: through toFixed. */
export const round = (v: number, n = 2): number => Number(v.toFixed(n));
export const dist = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.z - b.z);
/** Wraps an angle to (−π, π]. */
export const angle = (a: number): number =>
  Math.atan2(Math.sin(a), Math.cos(a));
/** The heading from a to b. */
export const heading = (a: Point, b: Point): number =>
  Math.atan2(b.x - a.x, a.z - b.z);
export const move = (p: Point, h: number, d: number): Point => ({
  x: p.x + Math.sin(h) * d,
  z: p.z - Math.cos(h) * d,
});

export interface Nearest extends Point {
  distance: number;
  index: number;
  t: number;
  s: number;
  heading: number;
}

/** The nearest point on a polyline, searching from 15 segments before `hint`. */
export function nearestOnPath(
  p: Point,
  points: PathPoint[],
  hint = 0,
): Nearest {
  let best: Nearest = {
    distance: Number.POSITIVE_INFINITY,
    index: 0,
    t: 0,
    x: 0,
    z: 0,
    s: 0,
    // Unset until a segment is found; callers never read it on an empty path.
    heading: Number.NaN,
  };
  for (let i = Math.max(0, hint - 15); i < points.length - 1; i++) {
    const a = points[i] as PathPoint;
    const b = points[i + 1] as PathPoint;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const t = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / (l2 || 1), 0, 1);
    const x = a.x + dx * t;
    const z = a.z + dz * t;
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < best.distance)
      best = {
        distance: d,
        index: i,
        t,
        x,
        z,
        s: a.s + Math.sqrt(l2) * t,
        heading: heading(a, b),
      };
  }
  return best;
}

/** The point `s` meters along a polyline, clamped to its ends. */
export function pointAt(points: PathPoint[], s: number): PathPoint {
  const first = points[0] as PathPoint;
  const last = points[points.length - 1] as PathPoint;
  if (s <= 0) return first;
  if (s >= last.s) return last;
  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const m = (lo + hi) >> 1;
    if ((points[m] as PathPoint).s < s) lo = m;
    else hi = m;
  }
  const a = points[lo] as PathPoint;
  const b = points[hi] as PathPoint;
  const t = (s - a.s) / (b.s - a.s);
  return {
    x: mix(a.x, b.x, t),
    z: mix(a.z, b.z, t),
    s,
    heading: heading(a, b),
  };
}

/** Resamples a polyline at no more than `spacing` meters, with stations. */
export function samplePolyline(raw: Point[], spacing = 1): PathPoint[] {
  const first = raw[0] as Point;
  const pts: PathPoint[] = [{ ...first, s: 0 }];
  let s = 0;
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1] as Point;
    const b = raw[i] as Point;
    const d = dist(a, b);
    const n = Math.max(1, Math.ceil(d / spacing));
    for (let k = 1; k <= n; k++) {
      s += d / n;
      pts.push({ x: mix(a.x, b.x, k / n), z: mix(a.z, b.z, k / n), s });
    }
  }
  return pts;
}

export interface Box extends Point {
  id: string;
  width: number;
  depth: number;
}

/** Whether the segment a→b passes through an axis-aligned box (its ends excepted). */
export function blockedByBuilding(
  a: Point,
  b: Point,
  buildings: Box[],
  exclude?: string,
): boolean {
  for (const o of buildings) {
    if (o.id === exclude) continue;
    let tmin = 0.015;
    let tmax = 0.985;
    for (const axis of ["x", "z"] as const) {
      const d = b[axis] - a[axis];
      const r = (axis === "x" ? o.width : o.depth) / 2;
      if (Math.abs(d) < 1e-6) {
        if (a[axis] < o[axis] - r || a[axis] > o[axis] + r) {
          tmin = 2;
          break;
        }
      } else {
        let t1 = (o[axis] - r - a[axis]) / d;
        let t2 = (o[axis] + r - a[axis]) / d;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
      }
    }
    if (tmax >= tmin) return true;
  }
  return false;
}

export const last = <T>(items: readonly T[]): T => {
  const item = items[items.length - 1];
  if (item === undefined) throw new Error("last of an empty list");
  return item;
};

export const at = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
};
