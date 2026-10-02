// The driving baseline, deterministic: the fixed rule of the reference
// experiment, read off the request alone. Stop only for a reason other
// than a distant line; at a required stop take the stop-at-line path;
// otherwise the most progress for the least route and lane error, never a
// path with a predicted conflict. It is the oracle that proves the port.
// Off the road (the table then carries `recovery_distance`, which the
// experiment's trips never needed) it takes the path that ends nearest the
// way back.

import type { Answers, ChoiceAnswer } from "../../../contract/answer.ts";
import type { Decider } from "../../../contract/decider.ts";
import { DecideError } from "../../../contract/errors.ts";
import type { JsonValue, Request } from "../../../contract/request.ts";

export const RULE_MODEL = "baseline";

type Json = Record<string, JsonValue>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: JsonValue | undefined, fallback: number): number =>
  typeof value === "number" ? value : fallback;

/** The pick, with the whole (degenerate) distribution a deterministic rule has. */
function answer(keys: string[], choice: string): ChoiceAnswer {
  return {
    type: "choice",
    choice,
    probabilities: Object.fromEntries(
      keys.map((k) => [k, k === choice ? 1 : 0]),
    ),
  };
}

function unreadable(what: string): DecideError {
  return new DecideError("rejected", `the driving rule cannot read ${what}`);
}

/** Each candidate's row as named values, shared columns included. */
function rows(state: Json): (id: string) => Json {
  const candidates = state.candidates;
  if (
    !isObject(candidates) ||
    !Array.isArray(candidates.columns) ||
    !isObject(candidates.rows)
  )
    throw unreadable("the candidates table");
  const columns = candidates.columns;
  const table = candidates.rows;
  const shared = isObject(candidates.shared) ? candidates.shared : {};
  return (id) => {
    const row = table[id];
    if (!Array.isArray(row)) throw unreadable(`candidate ${id}`);
    const values: Json = { ...shared };
    columns.forEach((column, i) => {
      values[String(column)] = row[i] ?? null;
    });
    return values;
  };
}

export function decideByRule(request: Request): Answers {
  const { state, questions } = request;
  if (!isObject(state)) throw unreadable("the state");
  const answers: Answers = {};
  if (questions.motion?.type === "choice") {
    const keys = Object.keys(questions.motion.criteria);
    const reasons = Array.isArray(state.stop_reasons) ? state.stop_reasons : [];
    const lineOnly =
      reasons.length === 1 && reasons[0] === "required_stop_line_within_2_5m";
    const intersection = isObject(state.intersection) ? state.intersection : {};
    const stop =
      keys.includes("stop") &&
      (!keys.includes("drive") ||
        (reasons.length > 0 &&
          (!lineOnly || num(intersection.bumper_to_line, 0) <= 0.7)));
    answers.motion = answer(keys, stop ? "stop" : "drive");
  }
  if (questions.vector?.type === "choice") {
    const keys = Object.keys(questions.vector.criteria);
    const row = rows(state);
    const candidates = state.candidates as Json;
    const conflicts = isObject(candidates.conflicts)
      ? candidates.conflicts
      : {};
    const recovering = keys.some(
      (id) => typeof row(id).recovery_distance === "number",
    );
    const score = (id: string) => {
      const v = row(id);
      if (recovering)
        return (
          (conflicts[id] ? -1e6 : 0) -
          num(v.recovery_distance, 1e3) +
          0.01 * num(v.progress, 0)
        );
      return (
        (conflicts[id] ? -1e6 : 0) +
        (v.stop_at_line ? 1e5 : 0) +
        (v.on_road === false ? -1e3 : 0) +
        num(v.progress, 0) -
        2 * num(v.route_error, 0) -
        num(v.lane_error, 0) -
        0.05 * Math.abs(num(v.heading_error, 0))
      );
    };
    const best = keys.reduce((a, b) => (score(b) > score(a) ? b : a));
    answers.vector = answer(keys, best);
  }
  if (questions.route?.type === "choice") {
    const keys = Object.keys(questions.route.criteria);
    answers.route = answer(
      keys,
      keys.includes("keep") ? "keep" : (keys[0] as string),
    );
  }
  return answers;
}

export const drivingRule: Decider = {
  id: "rule",
  label: "Fixed rule",
  models: async () => [{ id: RULE_MODEL, label: "Baseline", available: true }],
  status: async () => ({ configured: true, reachable: true }),
  async decide(request) {
    return {
      decider: "rule",
      model: RULE_MODEL,
      answers: decideByRule(request),
      timings: { total: 0 },
    };
  },
};
