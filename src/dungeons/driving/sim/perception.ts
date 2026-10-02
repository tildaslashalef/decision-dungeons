// What the player's car can see: movers all around within sensor range,
// static objects within ±65° ahead, nothing behind a building.

import { blockedByBuilding, dist, round } from "../world/geometry.ts";
import { signalState } from "../world/grid.ts";
import type { Junction, WorldObject } from "../world/types.ts";
import type { Simulation } from "./simulation.ts";
import { type RelativeTraffic, relativeTrafficState } from "./traffic.ts";
import type { Obstacle } from "./types.ts";

export interface Seen extends Partial<RelativeTraffic> {
  id: string;
  type: string;
  ahead_m: number;
  right_m: number;
  speed_mps: number;
  signal?: string;
  crossing?: boolean;
}

const SENSED = new Set([
  "car",
  "motorcycle",
  "pedestrian",
  "building",
  "stop_sign",
  "traffic_light",
]);
const MOVERS = new Set(["car", "motorcycle", "pedestrian"]);

type Thing = Obstacle | WorldObject;

/** Refreshes `sim.perception`, nearest first, and the objects ever discovered. */
export function scanScene(sim: Simulation): void {
  const v = sim.player;
  const range = Math.max(80, Math.abs(v.speed) * 6);
  const found: Seen[] = [];
  const things: Thing[] = [
    ...sim.traffic,
    ...sim.pedestrians,
    ...sim.world.objects,
  ];
  for (const o of things) {
    if (!SENSED.has(o.type)) continue;
    const dx = o.x - v.x;
    const dz = o.z - v.z;
    const forward = dx * Math.sin(v.heading) - dz * Math.cos(v.heading);
    const right = dx * Math.cos(v.heading) + dz * Math.sin(v.heading);
    const distance = Math.hypot(dx, dz);
    const dynamic = MOVERS.has(o.type);
    if (
      distance > range ||
      (!dynamic && Math.abs(Math.atan2(right, forward)) > (65 * Math.PI) / 180)
    )
      continue;
    if (blockedByBuilding(v, o, sim.buildings, o.id)) continue;
    const previous = sim.discovered.get(o.id);
    sim.discovered.set(o.id, {
      first_seen_s: previous?.first_seen_s ?? round(sim.time, 1),
      last_seen_s: round(sim.time, 1),
      type: o.type,
    });
    const speed = "speed" in o ? o.speed : 0;
    found.push({
      id: o.id,
      type: o.type,
      ahead_m: round(forward, 1),
      right_m: round(right, 1),
      speed_mps: round(speed || 0, 1),
      ...(dynamic
        ? relativeTrafficState(
            v,
            o as Obstacle & { width: number; depth: number },
          )
        : {}),
      ...(o.type === "traffic_light"
        ? {
            signal: signalState(
              sim.world.byId[o.nodeId] as Junction,
              sim.time,
              o.approach,
            ).color,
          }
        : {}),
      ...(o.type === "pedestrian" ? { crossing: o.crossing && o.walking } : {}),
    });
  }
  sim.perception = found.sort(
    (a, b) =>
      Math.hypot(a.ahead_m, a.right_m) - Math.hypot(b.ahead_m, b.right_m),
  );
  sim.sensorRange = range;
}

/** Everything visible within 80 m, for the inspector; not part of any decision. */
export function visibleObjects(sim: Simulation) {
  const v = sim.player;
  const things: Thing[] = [
    ...sim.traffic,
    ...sim.pedestrians,
    ...sim.world.objects.filter((o) => o.type !== "parcel"),
  ];
  const visible = [];
  const occluded: string[] = [];
  for (const o of things) {
    const dx = o.x - v.x;
    const dz = o.z - v.z;
    const d = dist(v, o);
    const f = dx * Math.sin(v.heading) - dz * Math.cos(v.heading);
    const l = dx * Math.cos(v.heading) + dz * Math.sin(v.heading);
    const bearing = (Math.atan2(l, f) * 180) / Math.PI;
    const dynamic = MOVERS.has(o.type);
    if (d > 80 || (!dynamic && Math.abs(bearing) > 65)) continue;
    if (blockedByBuilding(v, o, sim.buildings, o.id)) {
      occluded.push(o.id);
      continue;
    }
    visible.push({
      id: o.id,
      type: o.type,
      distance_m: round(d),
      forward_m: round(f),
      right_m: round(l),
      bearing_deg: round(bearing),
      ...(o.type === "traffic_light"
        ? {
            signal: signalState(
              sim.world.byId[o.nodeId] as Junction,
              sim.time,
              o.approach,
            ).color,
          }
        : {}),
    });
  }
  visible.sort((a, b) => a.distance_m - b.distance_m);
  return { visible, occluded };
}
