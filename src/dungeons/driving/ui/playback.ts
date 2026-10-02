// Smooth motion from discrete simulation steps. Snapshots from the worker
// go on a timeline; a playback clock moves through it with wall time, and
// the view (what the scene and HUD read) is interpolated between the two
// snapshots around the clock. When the timeline runs short (a slow decider
// in turn-based play), the clock eases to a halt instead of stopping dead,
// and eases back up when the next turn arrives.

import type { Crash } from "../sim/simulation.ts";
import { angle, type PathPoint } from "../world/geometry.ts";
import type { World } from "../world/types.ts";
import type { CarLook, CarPose, Snapshot, WalkerPose } from "./protocol.ts";

export interface ViewCar extends CarPose {
  width: number;
  depth: number;
  color?: string;
  steering?: number;
  wheelSteering?: number;
  target?: number;
  route: { points: PathPoint[] };
}

export interface ViewWalker extends WalkerPose {
  width: number;
  depth: number;
}

/** What the scene, the minimap, and the HUD read each frame. */
export interface SceneSource {
  world: World;
  time: number;
  distance: number;
  paused: boolean;
  crash: Crash | null;
  player: ViewCar;
  traffic: ViewCar[];
  pedestrians: ViewWalker[];
}

/** Seconds of turn-based playback below which the clock starts to slow. */
const EASE_S = 0.15;
/**
 * Real-time playback stays this far behind the newest snapshot, so a pair
 * to interpolate is always there, even while the worker is busy planning.
 */
const REALTIME_DELAY_S = 0.1;
/** The fastest real-time playback catches up after falling behind. */
const CATCH_UP_RATE = 1.6;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpAngle = (a: number, b: number, t: number) => a + angle(b - a) * t;

export class Playback implements SceneSource {
  time = 0;
  distance = 0;
  paused = false;
  crash: Crash | null = null;
  player: ViewCar;
  traffic: ViewCar[] = [];
  pedestrians: ViewWalker[] = [];
  /** The latest snapshot at or before the clock: its discrete fields are what the HUD shows. */
  current: Snapshot;
  private frames: Snapshot[];
  private clock: number;
  private rate = 0;
  private looks = new Map<string, CarLook>();
  private route: { points: PathPoint[] };

  constructor(
    public world: World,
    first: Snapshot,
    route: PathPoint[],
    looks: CarLook[],
  ) {
    this.frames = [first];
    this.clock = first.t;
    this.current = first;
    this.route = { points: route };
    this.setLooks(looks);
    this.player = this.car(first.player, 1.9, 4.75);
    this.apply(first, first, 0);
  }

  setLooks(looks: CarLook[]): void {
    this.looks = new Map(looks.map((l) => [l.id, l]));
  }

  setRoute(points: PathPoint[]): void {
    this.route = { points };
  }

  /** The newest simulated second on the timeline. */
  get head(): number {
    return (this.frames[this.frames.length - 1] as Snapshot).t;
  }

  /** The outcome as of the newest snapshot: whether the run ends inside the buffer. */
  get headOutcome(): Snapshot["outcome"] {
    return (this.frames[this.frames.length - 1] as Snapshot).outcome;
  }

  /** Simulated seconds still to play. */
  get buffered(): number {
    return this.head - this.clock;
  }

  get now(): number {
    return this.clock;
  }

  /** Adds a snapshot; one at the same instant as the newest replaces it (a decision, no motion). */
  push(snapshot: Snapshot): void {
    const last = this.frames[this.frames.length - 1] as Snapshot;
    if (snapshot.t > last.t) this.frames.push(snapshot);
    else if (snapshot.t === last.t)
      this.frames[this.frames.length - 1] = snapshot;
  }

  /**
   * Moves the clock by `dt` wall seconds. Turn-based: at most real speed,
   * easing down as the timeline runs out. Real-time: holding a small delay
   * behind the newest snapshot, catching up when behind.
   */
  advance(dt: number, mode: "turn" | "realtime", finishing: boolean): void {
    let target: number;
    if (this.paused) target = 0;
    else if (mode === "turn")
      target = finishing ? 1 : Math.min(1, Math.max(0, this.buffered) / EASE_S);
    else
      target = Math.min(
        CATCH_UP_RATE,
        Math.max(0, 1 + (this.buffered - REALTIME_DELAY_S) * 2),
      );
    this.rate += (target - this.rate) * (1 - Math.exp(-dt * 10));
    if (this.paused) this.rate = 0;
    this.clock = Math.min(this.head, this.clock + dt * this.rate);
    this.sample();
  }

  private sample(): void {
    const frames = this.frames;
    let i = frames.length - 1;
    while (i > 0 && (frames[i] as Snapshot).t > this.clock) i--;
    const a = frames[i] as Snapshot;
    const b = frames[Math.min(i + 1, frames.length - 1)] as Snapshot;
    const t =
      b.t > a.t
        ? Math.min(1, Math.max(0, (this.clock - a.t) / (b.t - a.t)))
        : 0;
    this.apply(a, b, t);
    // Keep one snapshot before the clock to interpolate from.
    if (i > 1) frames.splice(0, i - 1);
  }

  private car(pose: CarPose, width: number, depth: number): ViewCar {
    return { ...pose, width, depth, route: this.route };
  }

  private apply(a: Snapshot, b: Snapshot, t: number): void {
    this.current = a;
    this.time = lerp(a.t, b.t, t);
    this.distance = lerp(a.distance, b.distance, t);
    this.crash = t >= 1 ? b.crash : a.crash;
    const p = a.player;
    const q = b.player;
    this.player = {
      ...this.car(p, 1.9, 4.75),
      x: lerp(p.x, q.x, t),
      z: lerp(p.z, q.z, t),
      heading: lerpAngle(p.heading, q.heading, t),
      speed: lerp(p.speed, q.speed, t),
      steering: lerp(p.steering, q.steering, t),
      wheelSteering: lerp(p.wheelSteering, q.wheelSteering, t),
      target: p.target,
    };
    const next = new Map(b.traffic.map((c) => [c.id, c]));
    this.traffic = a.traffic.map((c) => {
      const d = next.get(c.id);
      const look = this.looks.get(c.id);
      const motorcycle = (look?.type ?? c.type) === "motorcycle";
      const base = this.car(c, motorcycle ? 0.8 : 1.9, motorcycle ? 2.3 : 4.2);
      if (look) base.color = look.color;
      // A respawned car jumps; interpolate only real motion.
      if (!d || Math.hypot(d.x - c.x, d.z - c.z) > 5) return base;
      return {
        ...base,
        x: lerp(c.x, d.x, t),
        z: lerp(c.z, d.z, t),
        heading: lerpAngle(c.heading, d.heading, t),
      };
    });
    const walkers = new Map(b.pedestrians.map((w) => [w.id, w]));
    this.pedestrians = a.pedestrians.map((w) => {
      const d = walkers.get(w.id);
      const base = { ...w, width: 0.6, depth: 0.6 };
      if (!d || Math.hypot(d.x - w.x, d.z - w.z) > 3) return base;
      return {
        ...base,
        x: lerp(w.x, d.x, t),
        z: lerp(w.z, d.z, t),
        heading: lerpAngle(w.heading, d.heading, t),
      };
    });
    for (const [id, offset] of Object.entries(a.offsets)) {
      const node = this.world.byId[id];
      if (node) node.offset = offset;
    }
  }
}
