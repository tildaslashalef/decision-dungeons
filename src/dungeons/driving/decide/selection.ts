// Which candidates a decider may choose, and how its answers become one
// maneuver. Drive-or-stop is a question of its own, so many similar
// moving paths cannot outvote a single stop.

import type { Candidate } from "../sim/plan.ts";
import { FULL_STOP_DISTANCE_M } from "../sim/vehicle.ts";
import type { DecisionState } from "./state.ts";

/** The answers this module reads: a choice with its distribution. */
export interface ChoiceLike {
  choice: string;
  probabilities?: Record<string, number>;
}

export type DrivingAnswers = Partial<
  Record<"motion" | "vector" | "route", ChoiceLike>
>;

function vectorWeights(
  answer: ChoiceLike | undefined,
  candidates: Record<string, unknown>,
): Record<string, { probability: number; selected: boolean }> | null {
  if (!answer || !candidates || !Object.hasOwn(candidates, answer.choice))
    return null;
  const ids = Object.keys(candidates);
  const probabilities = answer.probabilities;
  if (
    !probabilities ||
    ids.some((id) => {
      const p = probabilities[id];
      return p === undefined || !Number.isFinite(p) || p < 0 || p > 1;
    })
  )
    return null;
  return Object.fromEntries(
    ids.map((id) => [
      id,
      {
        probability: probabilities[id] as number,
        selected: id === answer.choice,
      },
    ]),
  );
}

/** A short name for a candidate, as the HUD shows it. */
export function candidateName(candidate: Candidate | undefined): string {
  if (!candidate) return "Planning";
  if (!candidate.velocity_mps) return "Brake";
  if (candidate.stop_at_line) return "Approach stop line";
  const direction =
    candidate.steering < -0.025
      ? "Left"
      : candidate.steering > 0.025
        ? "Right"
        : "Straight";
  return `${candidate.velocity_mps < 0 ? "Reverse · " : ""}${direction}`;
}

const FORWARD_ONLY = new Set([
  "onramp",
  "merge",
  "interstate",
  "exit",
  "offramp",
]);

/**
 * The moving candidates a decider may take: no predicted collision, on the
 * road, the route's direction on highway sections, lane-following in a
 * queue, and in-lane (or returning) when any is.
 */
function movingCandidates(state: DecisionState): [string, Candidate][] {
  const entries = Object.entries(state.vectors);
  if (state.recovery?.blocked || state.speed_ceiling_mps === 0) return [];
  const moving = entries.filter(
    ([, v]) =>
      v.velocity_mps !== 0 && !(v.collision_imminent ?? v.collision_predicted),
  );
  const forwardOnly =
    !state.recovery?.active && FORWARD_ONLY.has(state.trip?.phase ?? "");
  const roadSafe = state.recovery?.active
    ? moving
    : moving.filter(
        ([, v]) =>
          v.stays_on_road && (!forwardOnly || v.follows_route_direction),
      );
  // A traffic queue is not an obstacle to drive around: exploratory
  // alternatives stay visible, but only lane-following ones are offered.
  const safe =
    state.traffic?.queue && !state.recovery?.active
      ? roadSafe.filter(([, v]) => v.queue_compatible)
      : roadSafe;
  const inLane = safe.filter(([, v]) => v.stays_in_lane);
  const returning = safe.filter(([, v]) => v.returning_to_lane);
  return state.recovery?.active
    ? safe
    : inLane.length
      ? inLane
      : returning.length
        ? returning
        : forwardOnly
          ? []
          : safe;
}

export interface StopAvailability {
  available: boolean;
  proximity_m: number;
  reasons: string[];
}

/** Whether a full stop may be offered, and why. */
export function stopAvailability(
  state: DecisionState,
  moving: [string, Candidate][] = movingCandidates(state),
): StopAvailability {
  const reasons: string[] = [];
  const blocker = state.scene?.blocking_object;
  if (
    blocker &&
    Number.isFinite(blocker.gap_m) &&
    blocker.gap_m <= FULL_STOP_DISTANCE_M
  )
    reasons.push("blocking_object_within_2_5m");
  const intersection = state.scene?.intersection;
  if (
    intersection &&
    !intersection.already_entered &&
    Number.isFinite(intersection.stop_line_ahead_m) &&
    intersection.stop_line_ahead_m >= -0.5 &&
    intersection.stop_line_ahead_m <= FULL_STOP_DISTANCE_M &&
    ((intersection.control === "stop" && !intersection.stop_completed) ||
      (intersection.control === "signal" &&
        (intersection.signal === "red" || intersection.signal === "amber")))
  )
    reasons.push("required_stop_line_within_2_5m");
  if (
    Number.isFinite(state.destination_m) &&
    state.destination_m <= FULL_STOP_DISTANCE_M
  )
    reasons.push("destination_reached");
  // An emergency fallback when every sampled movement is blocked; not
  // permission to stop while useful moving choices exist.
  if (!moving.length) reasons.push("no_eligible_moving_path");
  return {
    available: reasons.length > 0,
    proximity_m: FULL_STOP_DISTANCE_M,
    reasons,
  };
}

/** The eligible moving candidates, plus the stop when one may be offered. */
export function candidateChoices(
  state: DecisionState,
): Record<string, Candidate> {
  const moving = movingCandidates(state);
  const stop = stopAvailability(state, moving).available
    ? Object.entries(state.vectors)
        .filter(([, v]) => v.velocity_mps === 0)
        .slice(-1)
    : [];
  return Object.fromEntries([...moving, ...stop]);
}

export interface DecisionOptions {
  candidates: Record<string, Candidate>;
  moving: Record<string, Candidate>;
  stopId: string | undefined;
  motion: Record<string, null>;
}

export function decisionOptions(state: DecisionState): DecisionOptions {
  const candidates = candidateChoices(state);
  const moving = Object.fromEntries(
    Object.entries(candidates).filter(([, v]) => v.velocity_mps !== 0),
  );
  const stopId = Object.keys(candidates).find(
    (id) => candidates[id]?.velocity_mps === 0,
  );
  return {
    candidates,
    moving,
    stopId,
    motion: {
      ...(Object.keys(moving).length ? { drive: null } : {}),
      ...(stopId ? { stop: null } : {}),
    },
  };
}

export interface Selection {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  probability_basis: string;
}

/**
 * The maneuver the answers choose: the path when the motion is drive, the
 * stop otherwise. Null when the answers do not cover the options.
 */
export function decisionSelection(
  state: DecisionState,
  answers: DrivingAnswers,
): Selection | null {
  const { candidates, moving, stopId, motion } = decisionOptions(state);
  if (!vectorWeights(answers.motion, motion)) return null;
  if (Object.keys(moving).length && !vectorWeights(answers.vector, moving))
    return null;
  const m = answers.motion as Required<ChoiceLike>;
  const drive = m.probabilities.drive ?? 0;
  return {
    choice: (m.choice === "drive" ? answers.vector?.choice : stopId) as string,
    probabilities: Object.fromEntries(
      Object.keys(candidates).map((id) => [
        id,
        id === stopId
          ? (m.probabilities.stop as number)
          : drive *
            ((answers.vector as Required<ChoiceLike>).probabilities[
              id
            ] as number),
      ]),
    ),
    confidence: m.probabilities[m.choice] as number,
    probability_basis:
      "Motion probability × conditional path probability; stop uses motion probability directly",
  };
}
