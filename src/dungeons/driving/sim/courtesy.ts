// Deadlock release at stop signs: when every car at a junction has waited,
// the first arrival with a clear swept path is let through at a creep.

import { dist, heading, pointAt } from "../world/geometry.ts";
import type { Junction } from "../world/types.ts";
import { firstCollision } from "./collisions.ts";
import { crossingFor } from "./rules.ts";
import type { Simulation } from "./simulation.ts";
import type { Car } from "./types.ts";
import { maneuverSteering, physics } from "./vehicle.ts";

/** Whether the car's next 4.5 m (or its route's) is clear of every body, with a margin. */
function clearCreep(sim: Simulation, vehicle: Car): boolean {
  const ghost: Car = {
    ...vehicle,
    width: vehicle.width + 0.5,
    depth: vehicle.depth + 0.5,
  };
  const obstacles = [
    ...sim.traffic,
    sim.player,
    ...sim.pedestrians,
    ...sim.buildings,
  ]
    .filter(
      (o) =>
        o.id !== vehicle.id &&
        dist(vehicle, o) < 16 + Math.hypot(o.width || 0, o.depth || 0) / 2,
    )
    .map((object) => ({ object }));
  const candidate = { lane_offset_m: 0, lookahead_m: 4.5 };
  for (let i = 1; i <= 30; i++) {
    const before = { ...ghost };
    if (vehicle === sim.player)
      physics(ghost, maneuverSteering(ghost, candidate), 1.5, 0.1);
    else {
      const p = pointAt(vehicle.route.points, vehicle.s + i * 0.15);
      const next = pointAt(vehicle.route.points, vehicle.s + i * 0.15 + 0.2);
      Object.assign(ghost, p, { heading: heading(p, next) });
    }
    if (firstCollision(before, ghost, obstacles)) return false;
  }
  return true;
}

export function updateCourtesy(sim: Simulation): void {
  const cars = [sim.player, ...sim.traffic];
  for (const v of cars)
    v.waitingSince =
      Math.abs(v.speed) < 0.2 ? (v.waitingSince ?? sim.time) : null;
  if (sim.time < sim.nextCourtesy) return;
  sim.nextCourtesy = sim.time + 0.5;
  for (const [nodeId, grant] of sim.courtesy) {
    const car = cars.find((v) => v.id === grant.id);
    const node = sim.world.byId[nodeId] as Junction;
    if (
      !car ||
      sim.time - grant.at > 12 ||
      dist(car, node) > 22 ||
      !clearCreep(sim, car)
    )
      sim.courtesy.delete(nodeId);
  }
  for (const node of sim.world.nodes) {
    if (node.control !== "stop" || sim.courtesy.has(node.id)) continue;
    const nearby = cars.filter((v) => dist(v, node) < 24);
    if (nearby.length < 2 || nearby.some((v) => Math.abs(v.speed) > 0.2))
      continue;
    if (
      sim.pedestrians.some((p) => dist(p, node) < 13 && p.crossing && p.walking)
    )
      continue;
    const waiting = nearby
      .filter(
        (v) =>
          (v !== sim.player || sim.autopilot) &&
          v.waitingSince !== null &&
          v.waitingSince !== undefined &&
          sim.time - v.waitingSince >= 4 &&
          v.stops[node.id]?.served &&
          crossingFor(v)?.nodeId === node.id,
      )
      .sort(
        (a, b) =>
          (a.stops[node.id]?.arrived as number) -
            (b.stops[node.id]?.arrived as number) || a.id.localeCompare(b.id),
      );
    const winner = waiting.find((v) => clearCreep(sim, v));
    if (winner) {
      sim.courtesy.set(node.id, { id: winner.id, at: sim.time });
      sim.locks.set(node.id, { id: winner.id, at: sim.time });
      if (winner === sim.player)
        sim.event("Traffic is stopped — taking a clear gap at walking speed");
    }
  }
}
