// Autopilot driving: a car crosses a seeded town, city, or interstate trip
// while a decider chooses its maneuvers, or faces one of the scenario
// checks (scenarios.ts). Turn-based by default: each decision is followed
// by 0.3 s of simulated time (six 50 ms steps), the cadence of the reference simulator's
// headless checks.

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
import { SCENARIOS, type ScenarioRun, scenarioById } from "./scenarios.ts";
import { chooseRoute } from "./sim/navigation.ts";
import { scanScene } from "./sim/perception.ts";
import { Simulation } from "./sim/simulation.ts";
import { round } from "./world/geometry.ts";
import type { WorldType } from "./world/types.ts";

/** Simulated seconds between decisions in turn-based play, as six steps. */
export const TURN_STEPS = 6;
export const STEP_S = 0.05;
/** A trip that has not arrived after this many decisions has failed. */
export const MAX_DECISIONS = 600;

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
  ...SCENARIOS.map(({ id, title, description }) => ({
    id,
    title,
    description,
  })),
];

/** The world a level drives in: a trip's own, or its scenario's. */
export const worldOf = (level: string): WorldType =>
  scenarioById(level)?.world ?? (level as WorldType);

export interface DrivingRun {
  sim: Simulation;
  level: string;
  decisions: number;
  /** Steps the safety brake overrode the chosen speed. */
  brakeSteps: number;
  steps: number;
  /** The state and request of the decision being made. */
  pending: { state: DecisionState; prepared: PreparedRequest } | null;
  /** The scenario check, on a scenario level. */
  scenario: ScenarioRun | null;
}

function records(run: DrivingRun): DecisionRecord[] {
  // Events are newest first; records read oldest first.
  return [...run.sim.events].reverse().map((event, index) => ({
    index,
    summary: `${event.time.toFixed(1)} s · ${event.text}`,
    ...(event.type === "error" ? { violation: event.text } : {}),
  }));
}

/**
 * Ends a turn: a scenario notes what the turn did (the stop-line check
 * turns its light green after a stop). `advance` calls it after its steps;
 * a view that paces the same steps over frames calls it once they are done.
 */
export function settleTurn(run: DrivingRun): void {
  run.scenario?.settle(run.sim, run.decisions);
}

export const driving: Dungeon<DrivingRun> = {
  id: "driving",
  title: "Autopilot driving",
  description:
    "Drive a seeded town, city, or interstate trip, or take a scenario check: a stop line, a stop sign, a merge, a blocked lane, off-road recovery.",
  levels: LEVELS,
  evaluation:
    "No safety nets: paths are offered up to the speed limit whatever the traffic ahead, paths predicted to collide stay in, and no brake overrides the chosen speed.",
  create(seed, level, options = {}) {
    if (!LEVELS.some((l) => l.id === level))
      throw new Error(`driving has no level ${level}`);
    const sim = new Simulation(seed, worldOf(level));
    sim.autopilot = true;
    if (options.evaluation) {
      sim.evaluation = true;
      sim.safety = false;
      sim.yieldStops = true;
    }
    const scenario = scenarioById(level)?.setup(sim) ?? null;
    return {
      sim,
      level,
      decisions: 0,
      brakeSteps: 0,
      steps: 0,
      pending: null,
      scenario,
    };
  },
  observe(run) {
    if (run.scenario) {
      run.scenario.hold(run.sim);
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
    run.scenario?.applied(candidate.velocity_mps);
  },
  advance(run) {
    if (run.scenario?.done()) return;
    for (let i = 0; i < TURN_STEPS; i++) {
      run.scenario?.hold(run.sim);
      run.sim.step(STEP_S);
      run.steps++;
      if (run.sim.brakeReason) run.brakeSteps++;
    }
    settleTurn(run);
  },
  step(run, dt) {
    run.scenario?.hold(run.sim);
    run.sim.step(dt);
    run.steps++;
    if (run.sim.brakeReason) run.brakeSteps++;
  },
  outcome(run): Outcome {
    const { sim, scenario } = run;
    const metrics: Record<string, number> = {
      decisions: run.decisions,
      sim_s: round(sim.time, 2),
      distance_m: round(sim.distance, 1),
      collisions: sim.collisions,
      ...(run.steps
        ? { safety_brake_pct: Math.round((100 * run.brakeSteps) / run.steps) }
        : {}),
    };
    if (scenario) {
      const verdict = scenario.verdict(sim, run.decisions);
      return {
        finished: verdict.finished,
        ...(verdict.passed !== undefined ? { passed: verdict.passed } : {}),
        violations: sim.violations,
        metrics: { ...metrics, ...verdict.metrics },
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
