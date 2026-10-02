// Autopilot driving: a car crosses a seeded town, city, or interstate trip
// while a decider chooses its maneuvers, or faces the stop-line check.
// Turn-based by default: each decision is followed by 0.3 s of simulated
// time (six 50 ms steps), the cadence of JevPilot's headless checks.

import type { Answers } from "../../contract/answer.ts";
import type { DecisionRecord, Dungeon, Level, Outcome } from "../dungeon.ts";
import {
  expandAnswers,
  type PreparedRequest,
  prepareRequest,
} from "./decide/request.ts";
import { drivingRule } from "./decide/rule.ts";
import {
  type DrivingAnswers,
  decisionOptions,
  decisionSelection,
} from "./decide/selection.ts";
import { type DecisionState, decisionState } from "./decide/state.ts";
import { chooseRoute } from "./sim/navigation.ts";
import { scanScene } from "./sim/perception.ts";
import { Simulation } from "./sim/simulation.ts";
import { pointAt, round } from "./world/geometry.ts";
import type { Crossing, Junction, WorldType } from "./world/types.ts";

/** Simulated seconds between decisions in turn-based play, as six steps. */
export const TURN_STEPS = 6;
export const STEP_S = 0.05;
/** A trip that has not arrived after this many decisions has failed. */
export const MAX_DECISIONS = 600;
const STOP_LINE_DECISIONS = 100;
/** The stop-line check passes with the car's center this close to the line, bumper short of it. */
export const STOP_LINE_PASS_M = 3.5;

const LEVELS: Level[] = [
  {
    id: "town",
    title: "Cedar Town",
    description:
      "Room between the crossroads: signals, stop signs, traffic, pedestrians.",
  },
  {
    id: "city",
    title: "Skyline City",
    description: "Long avenues, twice the traffic, a higher horizon.",
  },
  {
    id: "highway",
    title: "Interstate 08",
    description:
      "Millbrook streets, the on-ramp and merge, open road, the Cedar Town exit.",
  },
  {
    id: "stop-line",
    title: "Stop-line check",
    description: `A red light, no traffic: stop with the car's center within ${STOP_LINE_PASS_M} m of the line, then go on green.`,
  },
];

interface StopLineCheck {
  crossing: Crossing;
  node: Junction;
  northSouth: boolean;
  phase: "red" | "green" | "done";
  stoppedCenterM?: number;
  resumed?: boolean;
}

export interface DrivingRun {
  sim: Simulation;
  level: string;
  decisions: number;
  /** Steps the safety brake overrode the chosen speed. */
  brakeSteps: number;
  steps: number;
  /** The state and request of the decision being made. */
  pending: { state: DecisionState; prepared: PreparedRequest } | null;
  check: StopLineCheck | null;
}

/** Holds the check's signal red (or green) whatever the clock says. */
function holdSignal(run: DrivingRun): void {
  const check = run.check;
  if (!check) return;
  const red = check.phase === "red";
  check.node.offset = (check.northSouth === red ? 12 : 2) - run.sim.time;
}

function createStopLine(sim: Simulation): StopLineCheck {
  const v = sim.player;
  sim.traffic = [];
  sim.pedestrians = [];
  const crossing = v.route.crossings.find(
    (c) => sim.world.byId[c.nodeId]?.control === "signal",
  );
  if (!crossing)
    throw new Error("this world has no signalled crossing on the route");
  const node = sim.world.byId[crossing.nodeId] as Junction;
  v.s = crossing.stopS - 65;
  Object.assign(v, pointAt(v.route.points, v.s));
  v.heading = crossing.approach;
  return {
    crossing,
    node,
    northSouth: Math.abs(Math.cos(crossing.approach)) > 0.5,
    phase: "red",
  };
}

function records(run: DrivingRun): DecisionRecord[] {
  // Events are newest first; records read oldest first.
  return [...run.sim.events].reverse().map((event, index) => ({
    index,
    summary: `${event.time.toFixed(1)} s · ${event.text}`,
    ...(event.type === "error" ? { violation: event.text } : {}),
  }));
}

export const driving: Dungeon<DrivingRun> = {
  id: "driving",
  title: "Autopilot driving",
  description:
    "Drive a seeded town, city, or interstate trip: signals, stop signs, traffic, pedestrians, and a stop-line check.",
  levels: LEVELS,
  create(seed, level) {
    if (!LEVELS.some((l) => l.id === level))
      throw new Error(`driving has no level ${level}`);
    const world: WorldType =
      level === "stop-line" ? "town" : (level as WorldType);
    const sim = new Simulation(seed, world);
    sim.autopilot = true;
    const check = level === "stop-line" ? createStopLine(sim) : null;
    return {
      sim,
      level,
      decisions: 0,
      brakeSteps: 0,
      steps: 0,
      pending: null,
      check,
    };
  },
  observe(run) {
    if (run.check) {
      holdSignal(run);
      scanScene(run.sim);
    }
    const state = decisionState(run.sim);
    const prepared = prepareRequest(state);
    run.pending = { state, prepared };
    return { request: prepared.request, resolved: prepared.fixed };
  },
  apply(run, answers: Answers) {
    const pending = run.pending;
    if (!pending) return;
    run.pending = null;
    run.decisions++;
    const { state, prepared } = pending;
    const expanded = expandAnswers(prepared, answers) as DrivingAnswers;
    // Answers without a distribution still choose; the distribution is for display.
    const choice =
      decisionSelection(state, expanded)?.choice ??
      (expanded.motion?.choice === "drive"
        ? expanded.vector?.choice
        : decisionOptions(state).stopId);
    const candidate = choice ? state.vectors[choice] : undefined;
    if (!candidate) return;
    const v = run.sim.player;
    v.maneuver = candidate;
    v.steering = candidate.steering;
    v.target = candidate.velocity_mps;
    const route = expanded.route?.choice;
    if (route && route !== "keep") chooseRoute(run.sim, route);
    if (run.check?.phase === "green") {
      run.check.resumed = candidate.velocity_mps > 0;
      run.check.phase = "done";
    }
  },
  advance(run) {
    if (run.check?.phase === "done") return;
    for (let i = 0; i < TURN_STEPS; i++) {
      holdSignal(run);
      run.sim.step(STEP_S);
      run.steps++;
      if (run.sim.brakeReason) run.brakeSteps++;
    }
    const check = run.check;
    if (
      check?.phase === "red" &&
      run.decisions > 1 &&
      run.sim.player.speed < 0.1
    ) {
      check.stoppedCenterM = check.crossing.stopS - run.sim.player.s;
      check.phase = "green";
    }
  },
  step(run, dt) {
    holdSignal(run);
    run.sim.step(dt);
    run.steps++;
    if (run.sim.brakeReason) run.brakeSteps++;
  },
  outcome(run): Outcome {
    const { sim, check } = run;
    const metrics: Record<string, number> = {
      decisions: run.decisions,
      sim_s: round(sim.time, 2),
      distance_m: round(sim.distance, 1),
      collisions: sim.collisions,
      ...(run.steps
        ? { safety_brake_pct: Math.round((100 * run.brakeSteps) / run.steps) }
        : {}),
    };
    if (check) {
      const exhausted =
        check.phase === "red" && run.decisions >= STOP_LINE_DECISIONS;
      const finished = check.phase === "done" || exhausted || !!sim.crash;
      const center = check.stoppedCenterM;
      if (center !== undefined) {
        metrics.stopped_center_m = round(center, 2);
        metrics.bumper_gap_m = round(center - sim.player.depth / 2, 2);
      }
      const stoppedWell =
        center !== undefined &&
        center < STOP_LINE_PASS_M &&
        center > sim.player.depth / 2;
      return {
        finished,
        ...(finished
          ? {
              passed:
                stoppedWell &&
                check.resumed === true &&
                sim.collisions === 0 &&
                sim.violations === 0,
            }
          : {}),
        violations: sim.violations,
        metrics,
        records: records(run),
      };
    }
    const finished =
      sim.complete || !!sim.crash || run.decisions >= MAX_DECISIONS;
    metrics.arrived = sim.complete ? 1 : 0;
    return {
      finished,
      ...(finished
        ? {
            passed:
              sim.complete && sim.collisions === 0 && sim.violations === 0,
          }
        : {}),
      violations: sim.violations,
      metrics,
      records: records(run),
    };
  },
  rule: drivingRule,
};
