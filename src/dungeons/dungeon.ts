// The interface every dungeon implements. A dungeon turns its state into a
// request and answers into actions; it never names a decider. Everything
// here is headless and deterministic: same seed, same answers, same run.

import type { Answers } from "../contract/answer.ts";
import type { Decider } from "../contract/decider.ts";
import type { Request } from "../contract/request.ts";

export interface Level {
  id: string;
  title: string;
  description: string;
}

export interface Observation {
  /** The questions a decider must answer; may be empty when every question resolved locally. */
  request: Request;
  /** Answers the dungeon settled itself, e.g. a question with one option. */
  resolved?: Answers;
}

export interface DecisionRecord {
  index: number;
  /** One line a person reads: what was asked and what was done. */
  summary: string;
  correct?: boolean;
  /** Set when the action broke a rule of the dungeon. */
  violation?: string;
}

export interface Outcome {
  finished: boolean;
  /** Whether the run met the level's pass bound; absent until finished. */
  passed?: boolean;
  violations: number;
  /** Dungeon-defined numbers, the columns of a comparison table. */
  metrics: Record<string, number>;
  records: DecisionRecord[];
}

export interface Dungeon<Run> {
  id: string;
  title: string;
  description: string;
  levels: Level[];
  create(seed: number, level: string): Run;
  observe(run: Run): Observation;
  apply(run: Run, answers: Answers): void;
  /** Advances simulated time; a turn-based dungeon advances in `apply` and ignores this. */
  step(run: Run, dt: number): void;
  outcome(run: Run): Outcome;
  /** The dungeon's deterministic baseline. */
  rule: Decider;
}

/** A dungeon whose run type is opaque: each run stays with the dungeon that made it. */
export type AnyDungeon = Dungeon<unknown>;
