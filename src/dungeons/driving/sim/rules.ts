// Traffic rules at junctions: what the next control requires of a car,
// whose turn it is, the player's remembered stops, and the speed each car
// may drive now. Traffic obeys these as scripts; the player's car is told
// them and its decider chooses.

import { angle, dist, pointAt, round } from "../world/geometry.ts";
import { signalState } from "../world/grid.ts";
import type { Crossing, Junction } from "../world/types.ts";
import type { Simulation } from "./simulation.ts";
import {
  type Conflict,
  followingSpeed,
  type Lead,
  leadVehicle,
  predictTrafficConflict,
} from "./traffic.ts";
import type { Car } from "./types.ts";
import { routeSpeedLimit, stopLineDistance } from "./vehicle.ts";

/** The player must sit still this long for a stop to count. */
export const PLAYER_STOP_DWELL_S = 0.6;

/** The next junction on the car's route that it has not cleared by 19 m. */
export function crossingFor(v: Car): Crossing | undefined {
  return v.route.crossings.find((c) => c.stopS - v.s > -19);
}

export interface Rule {
  mustStop: boolean;
  /** Stop-line station minus the car's; negative once past. */
  distance: number;
  reason: string;
  color: "red" | "amber" | "green" | "stop" | null;
  nodeId?: string;
  stopCompleted?: boolean;
  walk?: boolean;
}

function rememberIntersectionStop(
  sim: Simulation,
  v: Car,
  crossing: Crossing,
  signal: string,
): void {
  const key = `${sim.routeVersion}:${crossing.nodeId}:${crossing.stopS}:${crossing.approach}`;
  if (v.intersectionMemory?.key !== key) {
    v.intersectionMemory = {
      key,
      nodeId: crossing.nodeId,
      stopCount: 0,
      stationarySince: null,
      currentStopRecorded: false,
      lastStop: null,
    };
    // A completed earlier visit to this junction is not this approach's stop.
    if (v.stops[crossing.nodeId]?.passed) delete v.stops[crossing.nodeId];
  }
  const memory = v.intersectionMemory;
  const line = {
    ...pointAt(v.route.points, crossing.stopS),
    heading: crossing.approach,
  };
  const lineDistance = stopLineDistance(v, line);
  const approaching =
    crossing.stopS - v.s > -0.7 &&
    lineDistance <= 80 &&
    dist(v, pointAt(v.route.points, v.s)) < 6 &&
    Math.abs(angle(v.heading - crossing.approach)) < 1.2;
  if (!approaching || Math.abs(v.speed) >= 0.2) {
    memory.stationarySince = null;
    memory.currentStopRecorded = false;
    return;
  }
  memory.stationarySince ??= sim.time;
  const duration = sim.time - memory.stationarySince;
  if (duration < PLAYER_STOP_DWELL_S) return;
  if (!memory.currentStopRecorded) {
    memory.stopCount++;
    memory.currentStopRecorded = true;
    memory.lastStop = {
      position: { x: v.x, z: v.z },
      progress: v.s,
      lineDistance,
      signal,
    };
  }
  const stop = memory.lastStop as NonNullable<typeof memory.lastStop>;
  stop.confirmedAt = sim.time;
  stop.duration = duration;
}

export interface StopMemory {
  approach_id: string;
  stops_on_this_approach: number;
  stopped_recently: boolean;
  currently_stopped: boolean;
  current_stop_duration_s: number;
  last_stop: {
    age_s: number;
    duration_s: number;
    stop_line_ahead_m: number;
    signal_at_stop: string | null;
    forward_progress_since_m: number;
  } | null;
}

/** What the player remembers about stopping on this approach. */
export function intersectionStopMemory(
  sim: Simulation,
  control: Crossing | undefined,
): StopMemory | null {
  const memory = sim.player.intersectionMemory;
  if (
    !control ||
    memory?.key !==
      `${sim.routeVersion}:${control.nodeId}:${control.stopS}:${control.approach}`
  )
    return null;
  const stop = memory.lastStop;
  const age = stop ? sim.time - (stop.confirmedAt as number) : null;
  return {
    approach_id: memory.key,
    stops_on_this_approach: memory.stopCount,
    stopped_recently: age !== null && age <= 30,
    currently_stopped: memory.stationarySince !== null,
    current_stop_duration_s:
      memory.stationarySince === null
        ? 0
        : round(sim.time - memory.stationarySince, 1),
    last_stop: stop
      ? {
          age_s: round(age as number, 1),
          duration_s: round(stop.duration as number, 1),
          stop_line_ahead_m: round(stop.lineDistance, 1),
          signal_at_stop: stop.signal,
          forward_progress_since_m: round(sim.player.s - stop.progress, 1),
        }
      : null,
  };
}

/**
 * What the next control requires of `v`. With `update`, also records the
 * car's arrival, served stop, amber decision, and junction reservation.
 */
export function rule(sim: Simulation, v: Car, update = false): Rule {
  const c = crossingFor(v);
  if (!c)
    return {
      mustStop: false,
      distance: Number.POSITIVE_INFINITY,
      reason: "Clear road",
      color: null,
    };
  const node = sim.world.byId[c.nodeId] as Junction;
  const delta = c.stopS - v.s;
  const signal =
    node.control === "signal"
      ? signalState(node, sim.time, c.approach)
      : { color: "stop" as const, walk: false };
  const amberKey = `${node.id}:${Math.floor((sim.time + node.offset) / 24)}`;
  if (update && signal.color === "amber" && v.amber?.key !== amberKey)
    v.amber = {
      key: amberKey,
      proceed:
        (v.speed * v.speed) / 16 > Math.max(0, delta - v.depth / 2 - 0.2),
    };
  const proceedOnAmber =
    v.amber?.key === amberKey
      ? v.amber.proceed
      : (v.speed * v.speed) / 16 > Math.max(0, delta - v.depth / 2 - 0.2);
  const inside = delta < -0.7;
  if (update && v === sim.player)
    rememberIntersectionStop(sim, v, c, signal.color);
  let stop = v.stops[c.nodeId];
  if (update && delta < 5.5 && delta > -0.7 && Math.abs(v.speed) < 0.2) {
    if (!stop) {
      stop = { arrived: sim.time, served: false };
      v.stops[c.nodeId] = stop;
    }
    stop.stationarySince ??= sim.time;
    if (
      sim.time - stop.stationarySince >=
      (v === sim.player ? PLAYER_STOP_DWELL_S : 1.2)
    )
      stop.served = true;
  } else if (update && stop) stop.stationarySince = null;
  let reason = "Clear road";
  let mustStop = false;
  if (!inside) {
    if (
      node.control === "signal" &&
      (signal.color === "red" || (signal.color === "amber" && !proceedOnAmber))
    ) {
      mustStop = true;
      reason = signal.walk
        ? "Pedestrian crossing"
        : `${signal.color === "amber" ? "Amber" : "Red"} light`;
    }
    if (node.control === "stop" && !stop?.served) {
      mustStop = true;
      reason = "Stop sign";
    }
    const grant = sim.courtesy.get(node.id);
    const released = grant?.id === v.id;
    const lock = sim.locks.get(node.id);
    // At signals the player's decider judges the traffic it sees; traffic's
    // reservation must not turn a green light into a blanket stop for it.
    const reservationRequired = node.control === "stop" || v !== sim.player;
    if (reservationRequired && !released && lock && lock.id !== v.id) {
      mustStop = true;
      reason = "Yield to crossing traffic";
    }
    if (node.control === "stop" && stop?.served && !released) {
      const arrived = stop.arrived;
      const waiting = [sim.player, ...sim.traffic].filter((o) => {
        const theirs = o.stops[node.id];
        return (
          o.id !== v.id &&
          theirs &&
          !theirs.passed &&
          crossingFor(o)?.nodeId === node.id &&
          theirs.arrived < arrived
        );
      });
      if (waiting.length) {
        mustStop = true;
        reason = "Yield to first arrival";
      }
    }
    if (grant && !released) {
      mustStop = true;
      reason = "Letting stopped traffic clear";
    }
    const pedestrians = sim.pedestrians.filter(
      (p) => p.crossing && p.walking && p.nodeId === node.id,
    );
    // The player's own path check handles pedestrians; someone crossing
    // another arm must not stop the whole junction for it.
    if (v !== sim.player && pedestrians.length) {
      mustStop = true;
      reason = "Yield to pedestrian";
    }
    if (update && !mustStop && delta < 3)
      sim.locks.set(node.id, { id: v.id, at: sim.time });
  } else if (update) {
    sim.locks.set(node.id, { id: v.id, at: sim.time });
    if (stop) stop.passed = true;
  }
  return {
    mustStop,
    distance: delta,
    reason,
    color: signal.color,
    nodeId: node.id,
    stopCompleted: !!stop?.served,
    walk: signal.walk,
  };
}

export interface Envelope {
  /** The speed the car may drive now. */
  max: number;
  /** The same before the current maneuver's own predicted conflict; what candidates are sampled under. */
  planningMax: number;
  /** The road's own bound (limit, destination) before any traffic; evaluation mode samples under it. */
  roadMax: number;
  reason: string | null;
  rule: Rule;
  gap: number;
  conflict: Conflict | null;
  lead: Lead<Car> | null;
  released: boolean;
}

/** The speed limit on `v` now: limits, rules (traffic only), destination, lead, predicted conflict. */
export function speedEnvelope(sim: Simulation, v: Car): Envelope {
  const r = rule(sim, v);
  const lead = leadVehicle(v, [...sim.traffic, sim.player]);
  const gap = lead?.gap ?? Number.POSITIVE_INFINITY;
  let max = Math.min(sim.world.theme.limit, routeSpeedLimit(v, v.s));
  let reason: string | null = null;
  // Traffic obeys the scripted rules; the player's decider gets them as
  // observations and decides when to approach, yield, or stop.
  if (v !== sim.player && r.mustStop && r.distance > -0.7) {
    const cap = Math.sqrt(2 * 5 * Math.max(0, r.distance - v.depth / 2 - 0.2));
    if (cap < max) {
      max = cap;
      reason = r.reason;
    }
  }
  if (v === sim.player && !sim.freeExplore) {
    const distance = Math.max(0, v.route.length - v.s);
    const destinationCap = Math.sqrt(2 * 5 * Math.max(0, distance - 1.5));
    if (destinationCap < max) {
      max = destinationCap;
      reason = "Destination ahead";
    }
  }
  const roadMax = max;
  const cap = followingSpeed(v, lead);
  if (cap < max) {
    max = cap;
    reason =
      lead?.other.type === "motorcycle" ? "Motorcycle ahead" : "Vehicle ahead";
  }
  // A hazard on the current maneuver must not zero every new candidate's
  // speed: each candidate predicts its own collisions, while the real-time
  // guard still checks the maneuver actually chosen.
  const planningMax = max;
  const conflict =
    v === sim.player
      ? predictTrafficConflict(v, [...sim.traffic, ...sim.pedestrians])
      : null;
  if (
    conflict?.braking_reduces_risk &&
    (conflict.max_speed_mps as number) < max
  ) {
    max = conflict.max_speed_mps as number;
    reason = conflict.reason;
  }
  const released = sim.courtesy.get(r.nodeId as string)?.id === v.id;
  if (v !== sim.player && released && !r.mustStop && !sim.complete) {
    max = Math.min(max, 1.5);
    if (max > 0) reason = "Taking a clear gap";
  }
  return {
    max,
    planningMax,
    roadMax,
    reason,
    rule: r,
    gap,
    conflict,
    lead,
    released,
  };
}
