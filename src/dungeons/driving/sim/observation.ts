// The whole world at one instant, for the inspector's "Full world" tab:
// what the car perceives plus everything it does not (junctions and their
// signals, roads, static objects, traffic controls, every vehicle and
// pedestrian, the planned route). Read-only: building it changes nothing,
// so opening the inspector can never change a run. Not part of any
// decision.

import { round } from "../world/geometry.ts";
import { signalState } from "../world/grid.ts";
import type { Junction } from "../world/types.ts";
import { navigation } from "./navigation.ts";
import { visibleObjects } from "./perception.ts";
import type { Simulation } from "./simulation.ts";

const degrees = (radians: number) => round((radians * 180) / Math.PI);

export function worldObservation(sim: Simulation) {
  const v = sim.player;
  const { visible, occluded } = visibleObjects(sim);
  const signal = (nodeId: string, approach: number) =>
    signalState(sim.world.byId[nodeId] as Junction, sim.time, approach);
  return {
    frame: {
      time_s: round(sim.time),
      seed: sim.world.seed,
      environment: sim.world.type,
      coordinates:
        "meters; +x east, +z south; heading 0 north; positive steering right",
    },
    ego: {
      position: { x: round(v.x), z: round(v.z) },
      heading_deg: degrees(v.heading),
      speed_mps: round(v.speed),
      steering_axis: round(v.steering ?? 0),
      velocity_axis_mps: round(v.target ?? 0),
      applied_velocity_mps: round(v.appliedTarget ?? v.target ?? 0),
      dimensions: { width: v.width, length: v.depth },
      route_station_m: round(v.s),
    },
    navigation: navigation(sim),
    sensor: {
      range_m: 80,
      occlusion: "line of sight blocked by building footprints",
      visible_count: visible.length,
      occluded_count: occluded.length,
      visible_objects: visible,
    },
    telemetry: {
      collisions: sim.collisions,
      crash: sim.crash,
      traffic_violations: sim.violations,
      distance_driven_m: round(sim.distance),
      arrived: sim.complete,
      brake_intervention: sim.brakeReason,
    },
    world: {
      bounds: sim.world.bounds,
      start: sim.world.route.points[0],
      destination: sim.world.route.points.at(-1),
      junctions: sim.world.nodes.map((n) => ({
        ...n,
        signal: n.control === "signal" ? signalState(n, sim.time, 0) : null,
      })),
      roads: sim.world.edges,
      static_objects: sim.world.objects,
      traffic_controls: sim.world.objects.flatMap((o) =>
        o.type === "traffic_light" || o.type === "stop_sign"
          ? [
              {
                id: o.id,
                node_id: o.nodeId,
                approach_heading_deg: degrees(o.approach),
                state:
                  o.type === "stop_sign"
                    ? { color: "stop" }
                    : signal(o.nodeId, o.approach),
              },
            ]
          : [],
      ),
      vehicles: sim.traffic.map(({ route, stops, ...car }) => ({
        ...car,
        route_node_ids: route.ids,
      })),
      pedestrians: sim.pedestrians,
      planned_route: sim.world.route,
      sensor_occluded_ids: occluded,
    },
  };
}
