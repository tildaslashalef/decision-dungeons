// Crossing: a car at a signalled stop line, asked to drive or stop. Each
// case has a known answer, so every decision is scored. It is the decisive
// moment of the driving stop-line check reduced to one question: read the
// signal, compare the distance to the line with a threshold.

import type { Answers } from "../../contract/answer.ts";
import type { Decider } from "../../contract/decider.ts";
import { DecideError } from "../../contract/errors.ts";
import type { Request } from "../../contract/request.ts";
import { hash, pick, type Rng, seeded } from "../../lib/random.ts";
import type { DecisionRecord, Dungeon, Level, Outcome } from "../dungeon.ts";

export type Signal = "red" | "amber" | "green";
export type Motion = "drive" | "stop";

/** On red or amber the car must stop once its bumper is this close to the line. */
export const STOP_WITHIN_M = 1;
export const CASES_PER_RUN = 12;

export interface CrossingCase {
  signal: Signal;
  /** Front bumper to the stop line, meters; positive is before the line. */
  bumperToLine: number;
  speed: number;
  expected: Motion;
}

export interface CrossingRun {
  seed: number;
  level: string;
  cases: CrossingCase[];
  /** The case being asked; equals cases.length when the run is over. */
  index: number;
  /** The motion chosen for each case answered so far. */
  answers: Motion[];
  records: DecisionRecord[];
}

const LEVELS: Level[] = [
  {
    id: "signal",
    title: "Read the signal",
    description:
      "The car is always inside the stopping zone; the signal alone decides.",
  },
  {
    id: "distance",
    title: "Distance to the line",
    description:
      "Always red: keep approaching until the bumper is within 1.0 m, then stop. Most cases sit near the threshold.",
  },
  {
    id: "mixed",
    title: "Signal and distance",
    description: "Any signal at any distance.",
  },
];

const round1 = (value: number) => Math.round(value * 10) / 10;
const between = (rng: Rng, low: number, high: number) =>
  round1(low + rng() * (high - low));

export function expectedMotion(signal: Signal, bumperToLine: number): Motion {
  return signal !== "green" && bumperToLine <= STOP_WITHIN_M ? "stop" : "drive";
}

function caseFor(level: string, rng: Rng): CrossingCase {
  let signal: Signal;
  let bumperToLine: number;
  switch (level) {
    case "signal":
      signal = pick(rng, ["red", "amber", "green"] as const);
      bumperToLine = between(rng, 0.2, STOP_WITHIN_M);
      break;
    case "distance":
      signal = "red";
      // Two in three near the threshold, where reading the number matters.
      bumperToLine = rng() < 2 / 3 ? between(rng, 0.4, 2) : between(rng, 2, 12);
      break;
    default:
      signal = pick(rng, ["red", "amber", "green"] as const);
      bumperToLine = rng() < 0.5 ? between(rng, 0.2, 2) : between(rng, 2, 12);
  }
  return {
    signal,
    bumperToLine,
    speed: between(rng, 0.5, 6),
    expected: expectedMotion(signal, bumperToLine),
  };
}

const INSTRUCTIONS = `Red or amber: keep approaching while the bumper is more than ${STOP_WITHIN_M.toFixed(1)} m from the line, then stop. Green: drive through.`;

export function crossingRequest(c: CrossingCase): Request {
  return {
    state: {
      units: "m, m/s",
      speed: c.speed,
      intersection: {
        control: "signal",
        signal: c.signal,
        bumper_to_line: c.bumperToLine,
      },
    },
    questions: {
      motion: {
        type: "choice",
        instructions: INSTRUCTIONS,
        criteria: {
          drive: "keep moving toward or through the line",
          stop: "brake to zero speed now",
        },
      },
    },
  };
}

function describe(c: CrossingCase): string {
  return `${c.signal}, ${c.bumperToLine.toFixed(1)} m`;
}

/** The fixed baseline: reads the signal and the distance and applies the rule. */
const rule: Decider = {
  id: "rule",
  label: "Fixed rule",
  models: async () => [{ id: "baseline", label: "Baseline", available: true }],
  status: async () => ({ configured: true, reachable: true }),
  async decide(request) {
    const state = request.state;
    const intersection =
      state && typeof state === "object" && !Array.isArray(state)
        ? state.intersection
        : undefined;
    const signal =
      intersection &&
      typeof intersection === "object" &&
      !Array.isArray(intersection)
        ? intersection.signal
        : undefined;
    const distance =
      intersection &&
      typeof intersection === "object" &&
      !Array.isArray(intersection)
        ? intersection.bumper_to_line
        : undefined;
    if (
      (signal !== "red" && signal !== "amber" && signal !== "green") ||
      typeof distance !== "number"
    )
      throw new DecideError(
        "rejected",
        "the crossing rule reads intersection.signal and bumper_to_line",
      );
    return {
      decider: "rule",
      model: "baseline",
      answers: {
        motion: { type: "choice", choice: expectedMotion(signal, distance) },
      },
      timings: { total: 0 },
    };
  },
};

export const crossing: Dungeon<CrossingRun> = {
  id: "crossing",
  title: "Crossing",
  description:
    "A signalled stop line: drive or stop. Seeded cases with known answers, scored per decision.",
  levels: LEVELS,
  create(seed, level) {
    if (!LEVELS.some((l) => l.id === level))
      throw new Error(`crossing has no level ${level}`);
    const rng = seeded(hash(level, seed));
    const cases = Array.from({ length: CASES_PER_RUN }, () =>
      caseFor(level, rng),
    );
    return { seed, level, cases, index: 0, answers: [], records: [] };
  },
  observe(run) {
    const c = run.cases[run.index];
    if (!c) throw new Error("the crossing run is over");
    return { request: crossingRequest(c) };
  },
  apply(run, answers: Answers) {
    const c = run.cases[run.index];
    const answer = answers.motion;
    if (!c || answer?.type !== "choice") return;
    const choice: Motion = answer.choice === "stop" ? "stop" : "drive";
    const correct = choice === c.expected;
    run.answers.push(choice);
    run.records.push({
      index: run.index,
      summary: `${describe(c)}: ${choice}${correct ? "" : ` (expected ${c.expected})`}`,
      correct,
      ...(c.expected === "stop" && choice === "drive"
        ? { violation: `ran the ${c.signal} light` }
        : {}),
    });
    run.index++;
  },
  step() {},
  outcome(run): Outcome {
    const finished = run.index >= run.cases.length;
    const correct = run.records.filter((r) => r.correct).length;
    const decided = run.records.length;
    return {
      finished,
      ...(finished ? { passed: correct === run.cases.length } : {}),
      violations: run.records.filter((r) => r.violation).length,
      metrics: {
        cases: run.cases.length,
        decided,
        correct,
        ...(decided ? { accuracy: correct / decided } : {}),
      },
      records: run.records,
    };
  },
  rule,
};
