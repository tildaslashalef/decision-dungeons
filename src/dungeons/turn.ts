// One decision turn of a run, shared by the browser and the CLI so both
// produce the same records from the same seed and answers.

import type { Answers, Decision } from "../contract/answer.ts";
import type { Request } from "../contract/request.ts";
import type { AnyDungeon, Observation, Outcome } from "./dungeon.ts";

export type DecideFn = (request: Request) => Promise<Decision>;

export interface Turn {
  observation: Observation;
  /** Absent when every question resolved locally and no decider was called. */
  decision?: Decision;
  answers: Answers;
  outcome: Outcome;
}

export async function playTurn(
  dungeon: AnyDungeon,
  run: unknown,
  decide: DecideFn,
): Promise<Turn> {
  const observation = dungeon.observe(run);
  const asked = Object.keys(observation.request.questions).length > 0;
  const decision = asked ? await decide(observation.request) : undefined;
  const answers: Answers = { ...observation.resolved, ...decision?.answers };
  dungeon.apply(run, answers);
  return {
    observation,
    ...(decision ? { decision } : {}),
    answers,
    outcome: dungeon.outcome(run),
  };
}
