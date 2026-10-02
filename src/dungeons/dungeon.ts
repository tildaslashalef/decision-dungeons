// The interface every dungeon implements. A dungeon turns its state into a
// request and answers into actions; it never names a decider. Everything
// here is headless and deterministic: same seed, same answers, same run.

import type { Answers } from "../contract/answer.ts";
import type { Decider } from "../contract/decider.ts";
import type { Request } from "../contract/request.ts";
import type { CaseSet } from "./text/cases.ts";

/**
 * What a level demands beyond its dungeon's usual, for the lobby to point
 * out: several questions about each case in one request, or inputs past a
 * short model's budget.
 */
export type LevelTag = "many-questions" | "long-input";

export interface Level {
  id: string;
  title: string;
  description: string;
  tags?: LevelTag[];
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

/** How a run is played, beside its seed and level. Recorded in every result. */
export interface RunOptions {
  /**
   * Turns off the dungeon's safety nets (see `Dungeon.evaluation`), so the
   * decider's choices alone decide the outcome.
   */
  evaluation?: boolean;
  /** The case set a text dungeon plays from (`Dungeon.caseSets`). */
  cases?: CaseSet;
}

export interface Dungeon<Run> {
  id: string;
  title: string;
  description: string;
  levels: Level[];
  /** What evaluation mode turns off; absent when the dungeon has no safety nets. */
  evaluation?: string;
  /** Plays cases from a stored case set, which `create` must be given. */
  caseSets?: true;
  create(seed: number, level: string, options?: RunOptions): Run;
  observe(run: Run): Observation;
  /**
   * Every remaining decision at once, for a dungeon whose decisions do not
   * depend on earlier answers; applying them in order plays the same run
   * as observing one at a time.
   */
  observeAll?(run: Run): Observation[];
  apply(run: Run, answers: Answers): void;
  /**
   * Turn-based play: advances simulated time from one decision to the next.
   * Time stands still while a decider thinks, so latency never scores.
   */
  advance?(run: Run): void;
  /** Real-time play: advances simulated time by `dt` seconds. */
  step(run: Run, dt: number): void;
  outcome(run: Run): Outcome;
  /** The dungeon's deterministic baseline. */
  rule: Decider;
}

/** A dungeon whose run type is opaque: each run stays with the dungeon that made it. */
export type AnyDungeon = Dungeon<unknown>;
