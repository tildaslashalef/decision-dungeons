// What a decider returns: Jev's answer fields, plus optional debug fields
// that only the debug sidebar reads. A field a decider does not report is
// absent, never a default.

import type { Request } from "./request.ts";

/** Per-answer internals some deciders expose (nuclis with `explain`). */
export interface AnswerDebug {
  /** One raw logit per option, in the order the question lists them. */
  logits?: number[];
  temperature?: number;
  /** The calibration bucket, e.g. "choice:2". */
  bucket?: string;
  /** The probability of the chosen option, the one calibration fits. */
  answerConfidence?: number;
  /** Tokens of the sequence the model read for this question. */
  tokensRead?: number;
  /** Tokens of the state that survived the budget. */
  stateKept?: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  debug?: AnswerDebug;
}

export interface ScoreAnswer {
  type: "score";
  /** The expected level, zero-based. */
  score: number;
  /** Keyed by level index as a string. */
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
  confidence?: number;
  debug?: AnswerDebug;
}

export interface NoulAnswer {
  type: "noul";
  /** P(the statement holds). */
  noul: number;
  debug?: AnswerDebug;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export type Answers = Record<string, Answer>;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Milliseconds. `total` is measured around the decider call; the rest are what the decider reports. */
export interface DecisionTimings {
  total: number;
  load?: number;
  tokenize?: number;
  encode?: number;
}

export interface DecisionDebug {
  /** The request as the decider received it, after `prepare`. */
  request?: Request;
  stateTokens?: number;
  /** The state was cut to fit the model's budget. */
  truncated?: boolean;
  /** Decisions answered in the same batch call, this one included. */
  batch?: number;
}

export interface Decision {
  decider: string;
  /** The model that answered, as the decider names it. */
  model: string;
  answers: Answers;
  usage?: Usage;
  timings: DecisionTimings;
  costUsd?: number;
  debug?: DecisionDebug;
}
