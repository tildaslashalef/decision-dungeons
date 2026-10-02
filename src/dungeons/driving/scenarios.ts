// The driving dungeon's scenario levels: deterministic setups that place
// the car, clear or script the other agents, and judge one skill against a
// stated pass bound. Each runs on the level's seeded world; a world that
// cannot host a scenario throws when the run is created.

import { footprintClearance } from "./sim/collisions.ts";
import type { Simulation } from "./sim/simulation.ts";
import type { Car } from "./sim/types.ts";
import {
  dist,
  heading,
  move,
  nearestOnPath,
  type PathPoint,
  pointAt,
  round,
} from "./world/geometry.ts";
import { localRoads, roadOccupancy } from "./world/road.ts";
import type { Junction, WorldType } from "./world/types.ts";
import { makeRoute, routeSection } from "./world/world.ts";

/** The stop-line check passes with the car's center this close to the line, bumper short of it. */
export const STOP_LINE_PASS_M = 3.5;
/** Blocked lane: stop with the bumper this close to the stopped car, without touching it. */
export const BLOCKED_GAP_M = 2.5;
/** Blocked lane: seconds at rest that settle the check. */
const BLOCKED_REST_S = 3;
/** Off-road recovery: back on the route within this many seconds. */
export const RECOVERY_S = 25;
/** Merge: on the interstate, clear of the merge lane, within this many seconds. */
export const MERGE_S = 45;
/** Stop sign: through the junction within this many seconds. */
const STOP_SIGN_S = 60;

/** A scenario's judgement: whether it is over, whether it passed, its numbers. */
export interface Verdict {
  finished: boolean;
  /** Absent until finished. */
  passed?: boolean;
  metrics: Record<string, number>;
}

/** One scenario run: scripts that hold the world, and the verdict. */
export interface ScenarioRun {
  /** Before every step and observation: holds a signal, scripts a car. */
  hold(sim: Simulation): void;
  /** After a turn's steps; `decisions` counts the decisions applied. */
  settle(sim: Simulation, decisions: number): void;
  /** After a decision chose a candidate moving at `velocity` m/s. */
  applied(velocity: number): void;
  /** True once the check is decided and simulated time should stop. */
  done(): boolean;
  verdict(sim: Simulation, decisions: number): Verdict;
  /** Signal offsets the scenario holds, for the renderer. */
  offsets(): Record<string, number>;
  /** The scenario's own state, for the inspector and the reference comparison. */
  facts(): Record<string, string | number | boolean | null>;
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  world: WorldType;
  /** The stage's words: the check's name and its two outcomes. */
  name: string;
  passTitle: string;
  failTitle: string;
  /** A finished run's facts, one short phrase each. */
  facts(metrics: Record<string, number>): string[];
  setup(sim: Simulation): ScenarioRun;
}

function clearAgents(sim: Simulation): void {
  sim.traffic = [];
  sim.pedestrians = [];
}

/** Puts the player at station `s` of its route, facing along it. */
function placePlayer(sim: Simulation, s: number, speed = 0): void {
  const v = sim.player;
  const p = pointAt(v.route.points, s);
  v.s = s;
  v.x = p.x;
  v.z = p.z;
  v.heading = heading(p, pointAt(v.route.points, s + 1));
  v.speed = speed;
  v.target = speed;
}

/** A scenario's own traffic car at station `s` of a route through `ids`. */
function scriptedCar(
  sim: Simulation,
  id: string,
  ids: string[],
  s: number,
  speed: number,
  laneOffset?: number,
): Car {
  const route = makeRoute(sim.world, ids, laneOffset);
  const p = pointAt(route.points, s);
  return {
    id,
    type: "car",
    x: p.x,
    z: p.z,
    heading: heading(p, pointAt(route.points, s + 1)),
    speed,
    target: speed,
    s,
    route,
    stops: {},
    width: 1.9,
    depth: 4.2,
    color: "#c8ccd2",
  };
}

// The stop line: a red light and no traffic. Stop with the car's center
// within STOP_LINE_PASS_M of the line, bumper short of it; on green, go.

function stopLine(sim: Simulation): ScenarioRun {
  const v = sim.player;
  clearAgents(sim);
  const crossing = v.route.crossings.find(
    (c) => sim.world.byId[c.nodeId]?.control === "signal",
  );
  if (!crossing)
    throw new Error("this world has no signalled crossing on the route");
  const node = sim.world.byId[crossing.nodeId] as Junction;
  v.s = crossing.stopS - 65;
  Object.assign(v, pointAt(v.route.points, v.s));
  v.heading = crossing.approach;
  const northSouth = Math.abs(Math.cos(crossing.approach)) > 0.5;
  let phase: "red" | "green" | "done" = "red";
  let stoppedCenterM: number | undefined;
  let resumed: boolean | undefined;
  return {
    // Holds the light red, then green, whatever the clock says.
    hold(s) {
      const red = phase === "red";
      node.offset = (northSouth === red ? 12 : 2) - s.time;
    },
    // A stop at the red line turns it green.
    settle(s, decisions) {
      if (phase === "red" && decisions > 1 && s.player.speed < 0.1) {
        stoppedCenterM = crossing.stopS - s.player.s;
        phase = "green";
      }
    },
    applied(velocity) {
      if (phase === "green") {
        resumed = velocity > 0;
        phase = "done";
      }
    },
    done: () => phase === "done",
    verdict(s, decisions) {
      const exhausted = phase === "red" && decisions >= 100;
      const finished = phase === "done" || exhausted || !!s.crash;
      const metrics: Record<string, number> = {};
      if (stoppedCenterM !== undefined) {
        metrics.stopped_center_m = round(stoppedCenterM, 2);
        metrics.bumper_gap_m = round(stoppedCenterM - s.player.depth / 2, 2);
      }
      const stoppedWell =
        stoppedCenterM !== undefined &&
        stoppedCenterM < STOP_LINE_PASS_M &&
        stoppedCenterM > s.player.depth / 2;
      return {
        finished,
        ...(finished
          ? {
              passed:
                stoppedWell &&
                resumed === true &&
                s.collisions === 0 &&
                s.violations === 0,
            }
          : {}),
        metrics,
      };
    },
    offsets: () => ({ [node.id]: node.offset }),
    facts: () => ({ phase, resumed: resumed ?? null }),
  };
}

// The stop sign: a cross-street car arrived first and waits at its line
// until the player has come to a full stop. Stop, let it go first, then
// cross: entering before it has would fail.

function stopSign(sim: Simulation): ScenarioRun {
  const v = sim.player;
  clearAgents(sim);
  const index = v.route.crossings.findIndex(
    (c) => sim.world.byId[c.nodeId]?.control === "stop" && c.stopS > 45,
  );
  const crossing = v.route.crossings[index];
  if (!crossing) throw new Error("this world has no stop sign on the route");
  const node = sim.world.byId[crossing.nodeId] as Junction;
  const from = v.route.ids[v.route.ids.indexOf(node.id) - 1];
  // A cross street: a neighbour whose street meets the player's at a right angle.
  const cross = node.neighbors
    .filter((id) => id !== from)
    .map((id) => sim.world.byId[id] as Junction)
    .filter(
      (n) => Math.abs(Math.cos(heading(n, node) - crossing.approach)) < 0.3,
    )
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!cross) throw new Error("the stop sign has no cross street");
  const beyond = node.neighbors
    .map((id) => sim.world.byId[id] as Junction)
    .find(
      (n) => Math.abs(Math.cos(heading(node, n) - heading(cross, node))) > 0.9,
    );
  const ids = [cross.id, node.id, (beyond ?? cross).id];
  const probe = makeRoute(sim.world, ids);
  const theirs = probe.crossings.find((c) => c.nodeId === node.id);
  if (!theirs) throw new Error("the cross street has no stop line");
  const other = scriptedCar(sim, "vehicle-first", ids, theirs.stopS - 2.8, 0);
  // Arrived before the run began; stopped long enough to have served it.
  other.stops[node.id] = { arrived: -5, served: true };
  sim.traffic = [other];
  sim.frozen.add(other.id);
  sim.yieldStops = true;
  placePlayer(sim, crossing.stopS - 40);
  let releaseAt: number | null = null;
  let entered: number | null = null;
  let otherPassed: number | null = null;
  let stoppedAt: number | null = null;
  let cutIn = false;
  return {
    hold(s) {
      const mine = s.player.stops[node.id];
      if (mine?.served && stoppedAt === null) stoppedAt = s.time;
      // Released a second after the player's full stop, or at 25 s regardless.
      if (releaseAt === null && (mine?.served || s.time > 25))
        releaseAt = s.time + 1;
      if (releaseAt !== null && s.time >= releaseAt) s.frozen.delete(other.id);
      if (otherPassed === null && other.stops[node.id]?.passed)
        otherPassed = s.time;
      if (entered === null && s.player.s >= crossing.stopS) {
        entered = s.time;
        if (otherPassed === null) cutIn = true;
      }
    },
    settle() {},
    applied() {},
    done: () => false,
    verdict(s, decisions) {
      const through = s.player.s > crossing.stopS + 20;
      const finished =
        through || !!s.crash || s.time > STOP_SIGN_S || decisions >= 250;
      const metrics: Record<string, number> = {
        yielded: entered === null ? 0 : cutIn ? 0 : 1,
      };
      if (stoppedAt !== null && entered !== null)
        metrics.waited_s = round(entered - stoppedAt, 1);
      if (otherPassed !== null && entered !== null && !cutIn)
        metrics.after_first_s = round(entered - otherPassed, 1);
      return {
        finished,
        ...(finished
          ? {
              passed:
                through && !cutIn && s.collisions === 0 && s.violations === 0,
            }
          : {}),
        metrics,
      };
    },
    offsets: () => ({}),
    facts: () => ({
      first_arrival: other.id,
      first_arrival_released: !sim.frozen.has(other.id),
      first_arrival_passed: otherPassed !== null,
      player_entered: entered !== null,
      cut_in: cutIn,
    }),
  };
}

// The merge: the on-ramp feeds a dense interstate stream with one wide gap.
// Merge without contact and be on the interstate within MERGE_S.

function merge(sim: Simulation): ScenarioRun {
  const v = sim.player;
  clearAgents(sim);
  const sections = v.route.sections ?? [];
  const ramp = sections.find((s) => s.kind === "onramp");
  const lane = sections.find((s) => s.kind === "merge");
  const interstate = sections.find((s) => s.kind === "interstate");
  if (!ramp || !lane || !interstate)
    throw new Error("this world has no on-ramp onto the interstate");
  placePlayer(sim, ramp.startS + 20, 12);
  // The interstate in the player's direction, right lane.
  const nodes = sim.world.nodes.filter((n) => /^h\d+$/.test(n.id));
  const used = v.route.ids.filter((id) => /^h\d+$/.test(id));
  const forward =
    nodes.findIndex((n) => n.id === used[0]) <=
    nodes.findIndex((n) => n.id === used.at(-1));
  const ids = (forward ? nodes : [...nodes].reverse()).map((n) => n.id);
  const route = makeRoute(sim.world, ids);
  const mergePoint = pointAt(v.route.points, lane.startS + 60);
  const atMerge = nearestOnPath(mergePoint, route.points).s;
  const speed = interstate.speedLimit;
  // When a car accelerating up the ramp (about 85% of its limit on
  // average) reaches the merge point, the gap's middle is there: six cars
  // 30 m apart, the gap 80 m wide.
  const arrival =
    (lane.startS + 60 - (ramp.startS + 20)) / (0.85 * ramp.speedLimit);
  const gapMiddle = atMerge - speed * arrival;
  const stations = [
    ...[0, 1, 2].map((j) => gapMiddle + 40 + 30 * j),
    ...[0, 1, 2].map((j) => gapMiddle - 40 - 30 * j),
  ];
  sim.traffic = stations
    .filter((s) => s > 5 && s < route.length - 5)
    .map((s, i) => scriptedCar(sim, `vehicle-stream-${i}`, ids, s, speed));
  sim.yieldStops = true;
  let mergedAt: number | null = null;
  return {
    hold(s) {
      const section = routeSection(s.player, s.player.s);
      if (
        mergedAt === null &&
        section?.kind === "interstate" &&
        s.player.s > lane.endS + 10
      )
        mergedAt = s.time;
    },
    settle() {},
    applied() {},
    done: () => false,
    verdict(s, decisions) {
      const finished =
        mergedAt !== null || !!s.crash || s.time > MERGE_S || decisions >= 300;
      const metrics: Record<string, number> = {};
      if (mergedAt !== null) metrics.merged_s = round(mergedAt, 1);
      return {
        finished,
        ...(finished
          ? {
              passed:
                mergedAt !== null && mergedAt <= MERGE_S && s.collisions === 0,
            }
          : {}),
        metrics,
      };
    },
    offsets: () => ({}),
    facts: () => ({ merged: mergedAt !== null }),
  };
}

// A blocked lane: a car stands still in the lane ahead and nothing else
// moves. Stop with the bumper within BLOCKED_GAP_M of it, without contact,
// and wait; or pass it cleanly.

function blockedLane(sim: Simulation): ScenarioRun {
  const v = sim.player;
  clearAgents(sim);
  // The first straight stretch of at least 70 m clear of junctions.
  const ends = [
    0,
    ...v.route.crossings.flatMap((c) => [c.stopS - 12, c.stopS + 22]),
    v.route.length - 10,
  ];
  let blockerS: number | null = null;
  for (let i = 0; i + 1 < ends.length; i += 2) {
    const start = ends[i] as number;
    const end = ends[i + 1] as number;
    if (end - start >= 70) {
      blockerS = end - 5;
      break;
    }
  }
  if (blockerS === null) throw new Error("this route has no 70 m straight");
  const blocker = scriptedCar(sim, "vehicle-stopped", v.route.ids, blockerS, 0);
  sim.traffic = [blocker];
  sim.frozen.add(blocker.id);
  placePlayer(sim, blockerS - 50);
  let restSince: number | null = null;
  let minGap = Number.POSITIVE_INFINITY;
  let passedBy = false;
  const gap = (s: Simulation) =>
    blocker.s - s.player.s - (blocker.depth + s.player.depth) / 2;
  return {
    hold(s) {
      if (s.player.s < blocker.s) minGap = Math.min(minGap, gap(s));
      if (s.player.s > blocker.s + 10) passedBy = true;
      if (Math.abs(s.player.speed) < 0.1) restSince ??= s.time;
      else restSince = null;
    },
    settle() {},
    applied() {},
    done: () => false,
    verdict(s, decisions) {
      const settled =
        restSince !== null &&
        s.time - restSince >= BLOCKED_REST_S &&
        s.player.s < blocker.s;
      const finished = settled || passedBy || !!s.crash || decisions >= 150;
      const metrics: Record<string, number> = {
        passed_by: passedBy ? 1 : 0,
      };
      if (Number.isFinite(minGap)) metrics.min_gap_m = round(minGap, 2);
      const stoppedWell = settled && gap(s) > 0 && gap(s) <= BLOCKED_GAP_M;
      return {
        finished,
        ...(finished
          ? {
              passed:
                (stoppedWell || passedBy) &&
                s.collisions === 0 &&
                s.violations === 0,
            }
          : {}),
        metrics,
      };
    },
    offsets: () => ({}),
    facts: () => ({
      blocker: blocker.id,
      gap_m: Number.isFinite(minGap) ? round(minGap, 2) : null,
      passed_by: passedBy,
    }),
  };
}

// Off-road recovery: the car starts beside the road, off the asphalt and
// clear of buildings. Back on the route within RECOVERY_S, no contact.

function offRoad(sim: Simulation): ScenarioRun {
  const v = sim.player;
  clearAgents(sim);
  const buildings = sim.buildings;
  let start: (PathPoint & { heading: number }) | null = null;
  for (const s of [40, 60, 80, 100, 120])
    for (const offset of [10, -10, 12, -12, 14, -14]) {
      if (start) break;
      const p = pointAt(v.route.points, s);
      const h = heading(p, pointAt(v.route.points, s + 1));
      const at = move(p, h + Math.PI / 2, offset);
      const pose = { ...at, heading: h, width: v.width, depth: v.depth };
      const off = !roadOccupancy(pose, localRoads(sim.world, pose)).on_road;
      const clear = buildings.every(
        (b) =>
          dist(b, pose) > 30 ||
          footprintClearance(pose, {
            x: b.x,
            z: b.z,
            heading: -(b.rotation || 0),
            width: b.width,
            depth: b.depth,
          }) > 1.5,
      );
      if (off && clear) start = { ...at, s, heading: h };
    }
  if (!start) throw new Error("no clear ground beside this route");
  v.x = start.x;
  v.z = start.z;
  v.heading = start.heading;
  v.s = nearestOnPath(v, v.route.points).s;
  v.speed = 0;
  v.target = 0;
  let recoveredAt: number | null = null;
  return {
    hold(s) {
      if (recoveredAt !== null) return;
      const p = s.player;
      const near = nearestOnPath(p, p.route.points);
      const onRoad = roadOccupancy(p, localRoads(s.world, p)).on_road;
      if (onRoad && near.distance <= 2.5) recoveredAt = s.time;
    },
    settle() {},
    applied() {},
    done: () => false,
    verdict(s, decisions) {
      const finished =
        recoveredAt !== null ||
        !!s.crash ||
        s.time > RECOVERY_S ||
        decisions >= 150;
      const metrics: Record<string, number> = {};
      if (recoveredAt !== null) metrics.recovered_s = round(recoveredAt, 1);
      return {
        finished,
        ...(finished
          ? {
              passed:
                recoveredAt !== null &&
                recoveredAt <= RECOVERY_S &&
                s.collisions === 0,
            }
          : {}),
        metrics,
      };
    },
    offsets: () => ({}),
    facts: () => ({ recovered: recoveredAt !== null }),
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: "stop-line",
    title: "Stop-line check",
    description: `A red light, no traffic: stop with the car's center within ${STOP_LINE_PASS_M} m of the line, then go on green.`,
    world: "town",
    name: "STOP-LINE CHECK",
    passTitle: "Stopped at the line.",
    failTitle: "Missed the line.",
    facts: (m) => [
      m.stopped_center_m !== undefined
        ? `center ${m.stopped_center_m} m from the line`
        : "never came to rest",
      m.bumper_gap_m !== undefined ? `bumper ${m.bumper_gap_m} m short` : "",
    ],
    setup: stopLine,
  },
  {
    id: "stop-sign",
    title: "Stop sign, first arrival",
    description:
      "A cross-street car reached the stop sign first: stop, let it go, then cross. Entering before it fails.",
    world: "town",
    name: "STOP-SIGN CHECK",
    passTitle: "Yielded, then crossed.",
    failTitle: "Did not yield.",
    facts: (m) => [
      m.yielded ? "let the first arrival go" : "went before the first arrival",
      m.waited_s !== undefined ? `waited ${m.waited_s} s at the line` : "",
    ],
    setup: stopSign,
  },
  {
    id: "merge",
    title: "Merge gap",
    description: `From the on-ramp into a dense interstate stream with one 80 m gap: merge without contact, on the interstate within ${MERGE_S} s.`,
    world: "highway",
    name: "MERGE CHECK",
    passTitle: "Merged cleanly.",
    failTitle: "No clean merge.",
    facts: (m) => [
      m.merged_s !== undefined
        ? `on the interstate at ${m.merged_s} s`
        : "never reached the interstate",
    ],
    setup: merge,
  },
  {
    id: "blocked-lane",
    title: "Blocked lane",
    description: `A car stands still in the lane ahead: stop within ${BLOCKED_GAP_M} m of it without contact, or pass it cleanly.`,
    world: "town",
    name: "BLOCKED-LANE CHECK",
    passTitle: "Handled the blocked lane.",
    failTitle: "Mishandled the blocked lane.",
    facts: (m) => [
      m.passed_by
        ? "passed the stopped car"
        : m.min_gap_m !== undefined
          ? `closest ${m.min_gap_m} m behind it`
          : "",
    ],
    setup: blockedLane,
  },
  {
    id: "off-road",
    title: "Off-road recovery",
    description: `The car starts off the asphalt beside its route: back on the route within ${RECOVERY_S} s without hitting anything.`,
    world: "town",
    name: "RECOVERY CHECK",
    passTitle: "Back on the road.",
    failTitle: "Stayed off the road.",
    facts: (m) => [
      m.recovered_s !== undefined
        ? `back on the route at ${m.recovered_s} s`
        : "never back on the route",
    ],
    setup: offRoad,
  },
];

export const scenarioById = (id: string): Scenario | undefined =>
  SCENARIOS.find((s) => s.id === id);
