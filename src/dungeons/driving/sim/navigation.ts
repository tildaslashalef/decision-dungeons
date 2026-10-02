// Where the player is going: the turn ahead, the trip phase on the highway,
// and recovery from a long departure, either automatic (a new route after
// six seconds more than 30 m off course) or by the decider's route choice.

import {
  angle,
  dist,
  heading,
  last,
  nearestOnPath,
  pointAt,
  round,
} from "../world/geometry.ts";
import {
  type RouteChoice,
  routeFromLocation,
  routesFromLocation,
} from "../world/reroute.ts";
import type { Route } from "../world/types.ts";
import { routeSection } from "../world/world.ts";
import { crossingFor } from "./rules.ts";
import { REROUTE_DISTANCE_M, type Simulation } from "./simulation.ts";

const REROUTE_DELAY_S = 6;
const REROUTE_COOLDOWN_S = 30;

/** Whether the player has been far off course long enough for a new route. */
export function routeChoiceNeeded(sim: Simulation): boolean {
  return (
    !sim.complete &&
    !sim.freeExplore &&
    !sim.crash &&
    sim.offRouteSince != null &&
    sim.time - sim.offRouteSince >= REROUTE_DELAY_S &&
    sim.time - sim.lastReroute >= REROUTE_COOLDOWN_S &&
    sim.time >= sim.routeHoldUntil &&
    nearestOnPath(sim.player, sim.player.route.points).distance >
      REROUTE_DISTANCE_M
  );
}

/** Replaces the player's route, keeping a served stop at the same approach. */
export function installRoute(
  sim: Simulation,
  next: Pick<RouteChoice, "route" | "progress">,
): boolean {
  // A late calculation may arrive after the car has rejoined.
  if (!routeChoiceNeeded(sim)) return false;
  const v = sim.player;
  const previousControl = crossingFor(v);
  const served = previousControl && v.stops[previousControl.nodeId];
  v.route = next.route;
  sim.world.route = next.route;
  v.s = next.progress;
  v.stops = {};
  const newControl = crossingFor(v);
  if (
    served &&
    previousControl &&
    newControl?.nodeId === previousControl.nodeId &&
    Math.abs(angle(newControl.approach - previousControl.approach)) < 0.1
  )
    v.stops[newControl.nodeId] = served;
  v.amber = null;
  v.maneuver = null;
  v.target = 0;
  for (const [id, lock] of sim.locks)
    if (lock.id === v.id) sim.locks.delete(id);
  for (const [id, grant] of sim.courtesy)
    if (grant.id === v.id) sim.courtesy.delete(id);
  sim.lastPlan = null;
  sim.lastDecisionState = null;
  sim.lastReroute = sim.time;
  sim.offRouteSince = null;
  sim.routeVersion++;
  sim.routeChoices = {};
  sim.nextRouteChoices = sim.time;
  sim.routeHoldUntil = 0;
  sim.event("Route recalculated from your current location");
  return true;
}

/** Every 0.75 s: tracks a departure and installs the best route once it lasts. */
export function rerouteIfNeeded(sim: Simulation): void {
  if (
    sim.complete ||
    sim.freeExplore ||
    sim.crash ||
    sim.time < sim.nextRouteCheck
  )
    return;
  sim.nextRouteCheck = sim.time + 0.75;
  const v = sim.player;
  const near = nearestOnPath(v, v.route.points);
  // Turns, queues, and recovery on the same street keep the route: only
  // distance from it counts, never heading or time stopped.
  if (near.distance <= REROUTE_DISTANCE_M) {
    sim.offRouteSince = null;
    sim.routeChoices = {};
    sim.routeChoicesOrigin = null;
    return;
  }
  sim.offRouteSince ??= sim.time;
  if (!routeChoiceNeeded(sim)) return;
  const next = routeFromLocation(
    sim.world,
    v,
    sim.destinationApproach,
    sim.destinationPoint,
  );
  if (!next) return;
  // On the shoulder of the right street: recover to it, without replacing
  // the same route over and over.
  if (next.route.ids.join(",") === v.route.ids.join(",")) return;
  installRoute(sim, next);
}

/** Up to three different first streets to offer the decider, every 4 s or 10 m. */
export function refreshRouteChoices(sim: Simulation): void {
  if (!routeChoiceNeeded(sim) || sim.time < sim.routeHoldUntil) {
    sim.routeChoices = {};
    return;
  }
  const control = crossingFor(sim.player);
  // Commit through a turn rather than changing plans halfway across it.
  if (
    control &&
    Math.abs(control.stopS - sim.player.s) < 18 &&
    sim.player.speed > 2
  ) {
    sim.routeChoices = {};
    return;
  }
  if (
    sim.time < sim.nextRouteChoices &&
    sim.routeChoicesOrigin &&
    dist(sim.player, sim.routeChoicesOrigin) < 10
  )
    return;
  sim.nextRouteChoices = sim.time + 4;
  sim.routeChoicesOrigin = { x: sim.player.x, z: sim.player.z };
  const candidates = routesFromLocation(
    sim.world,
    sim.player,
    sim.destinationApproach,
    sim.destinationPoint,
  );
  const current = sim.player.route.ids.join(",");
  const nearest = candidates[0];
  sim.routeChoices = {};
  if (!nearest) return;
  const selected = candidates.filter(
    (c) =>
      !current.endsWith(c.route.ids.join(",")) &&
      c.distance < nearest.distance + 5,
  );
  for (const choice of selected) {
    const key = choice.route.ids.slice(0, 3).join("_");
    if (sim.routeChoices[key]) continue;
    sim.routeChoices[key] = choice;
    if (Object.keys(sim.routeChoices).length === 3) break;
  }
}

/** Takes the route the decider chose, if it is still on offer and the car still near its origin. */
export function chooseRoute(sim: Simulation, id: string): boolean {
  if (!routeChoiceNeeded(sim)) return false;
  const next = sim.routeChoices[id];
  if (
    !next ||
    !sim.routeChoicesOrigin ||
    dist(sim.player, sim.routeChoicesOrigin) > 12
  )
    return false;
  const control = crossingFor(sim.player);
  if (
    control &&
    Math.abs(control.stopS - sim.player.s) < 18 &&
    sim.player.speed > 2
  )
    return false;
  const entry = next.route.points.filter((p) => p.s <= next.progress + 60);
  const progress = nearestOnPath(
    sim.player,
    entry.length > 1 ? entry : next.route.points,
  ).s;
  if (!installRoute(sim, { ...next, progress })) return false;
  sim.routeChoices = {};
  sim.nextRouteChoices = sim.time + 20;
  sim.routeHoldUntil = sim.time + 20;
  return true;
}

export interface RouteSummary {
  via: string[];
  remaining_m: number;
  join_distance_m: number;
  heading_change_deg: number;
}

export interface GlobalNavigation {
  coordinates: string;
  position: { x: number; z: number; heading_deg: number };
  destination: { node: string; x: number; z: number };
  junctions: { id: string; x: number; z: number; control: string }[];
  roads: [string, string, number, boolean, number, string][];
  road_fields: string[];
  stopped_traffic: { junction: string; vehicles: number }[];
  routes: Record<string, RouteSummary>;
}

/** The whole map and the route choices: sent only when a route must be chosen. */
export function globalNavigation(sim: Simulation): GlobalNavigation {
  refreshRouteChoices(sim);
  const v = sim.player;
  const describe = (
    route: Route,
    remaining: number,
    distance: number,
    relativeHeading = 0,
  ): RouteSummary => ({
    via: route.ids,
    remaining_m: round(remaining, 1),
    join_distance_m: round(distance, 1),
    heading_change_deg: round((relativeHeading * 180) / Math.PI, 1),
  });
  return {
    coordinates: "World meters: x east, z south; heading 0 north, 90 east",
    position: {
      x: round(v.x, 1),
      z: round(v.z, 1),
      heading_deg: round((v.heading * 180) / Math.PI, 1),
    },
    destination: {
      node: sim.world.destination,
      x: sim.destinationPoint.x,
      z: sim.destinationPoint.z,
    },
    junctions: sim.world.nodes.map((n) => ({
      id: n.id,
      x: n.x,
      z: n.z,
      control: n.control,
    })),
    roads: sim.world.edges.map((e) => [
      e.a,
      e.b,
      e.width,
      !!e.oneWay,
      e.speedLimit,
      e.kind ?? "street",
    ]),
    road_fields: [
      "from",
      "to",
      "width_m",
      "one_way",
      "speed_limit_mps",
      "kind",
    ],
    stopped_traffic: sim.world.nodes.flatMap((n) => {
      const waiting = sim.traffic.filter(
        (o) =>
          o.waitingSince != null &&
          sim.time - o.waitingSince > 6 &&
          dist(o, n) < 24,
      );
      return waiting.length
        ? [{ junction: n.id, vehicles: waiting.length }]
        : [];
    }),
    routes: {
      keep: describe(
        v.route,
        v.route.length - v.s,
        nearestOnPath(v, v.route.points).distance,
      ),
      ...Object.fromEntries(
        Object.entries(sim.routeChoices).map(([id, c]) => [
          id,
          describe(
            c.route,
            c.route.length - c.progress,
            c.distance,
            c.relativeHeading,
          ),
        ]),
      ),
    },
  };
}

export type Turn =
  | "uturn"
  | "straight"
  | "right"
  | "left"
  | "arrive"
  | "merge"
  | "exit";

export interface Navigation {
  remaining_m: number;
  route_version: number;
  rerouted: boolean;
  route_offset_m: number;
  heading_error_deg: number;
  lookahead: { x: number; z: number };
  next_turn: Turn;
  turn_distance_m: number;
  destination: { id: string; x: number; z: number; s: number };
  phase?: string;
  instruction?: string;
  road_name?: string;
  speed_limit_mps?: number;
}

const INSTRUCTIONS: Record<
  string,
  (turn: Turn, nodeId?: string) => [string, Turn]
> = {
  local: (turn, nodeId) => [
    nodeId === "mill-interchange" && turn === "left"
      ? "Turn left onto the Interstate 08 entrance"
      : turn === "left" || turn === "right"
        ? `Turn ${turn} through Millbrook`
        : "Continue through Millbrook",
    turn,
  ],
  ramp_turn: () => ["Take the Interstate 08 North on-ramp", "left"],
  onramp: () => ["Join the acceleration lane", "merge"],
  merge: () => ["Merge onto Interstate 08", "merge"],
  interstate: () => ["Take the Cedar Town exit", "exit"],
  exit: () => ["Follow the Cedar Town off-ramp", "exit"],
  offramp: () => ["Enter Cedar Town", "straight"],
  town: () => ["Stop at the town destination", "arrive"],
};

/** The next turn, the distance to it, and on the highway the trip phase. */
export function navigation(sim: Simulation): Navigation {
  const v = sim.player;
  const near = nearestOnPath(v, v.route.points);
  const look = pointAt(
    v.route.points,
    v.s + Math.max(5, Math.abs(v.speed) * 1.1),
  );
  const c = crossingFor(v);
  const turn = c ? angle(c.exit - c.approach) : 0;
  const nextTurn: Turn = c
    ? Math.abs(turn) > 3
      ? "uturn"
      : Math.abs(turn) < 0.3
        ? "straight"
        : turn > 0
          ? "right"
          : "left"
    : "arrive";
  const section = routeSection(v, near.s);
  const end = last(v.route.points);
  const base: Navigation = {
    remaining_m: round(Math.max(0, v.route.length - v.s)),
    route_version: sim.routeVersion,
    rerouted: sim.time - sim.lastReroute < 3,
    route_offset_m: round(near.distance),
    heading_error_deg: round(
      (angle(heading(v, look) - v.heading) * 180) / Math.PI,
    ),
    lookahead: { x: round(look.x), z: round(look.z) },
    next_turn: nextTurn,
    turn_distance_m: round(
      c ? Math.max(0, c.stopS - v.s + 10) : v.route.length - v.s,
    ),
    destination: { id: sim.world.destination, ...end },
  };
  if (!section) return base;
  const [instruction, sectionTurn] = (
    INSTRUCTIONS[section.kind] as (typeof INSTRUCTIONS)[string]
  )(nextTurn, c?.nodeId);
  return {
    ...base,
    phase: section.kind,
    instruction,
    road_name: section.name,
    speed_limit_mps: section.speedLimit,
    next_turn: sectionTurn,
    turn_distance_m: round(
      Math.max(
        0,
        c && ["local", "ramp_turn"].includes(section.kind)
          ? c.stopS - near.s + 10
          : section.endS - near.s,
      ),
    ),
  };
}
