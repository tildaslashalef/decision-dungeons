// The decision request every decider reads: Jev's shape, which `nuclis
// decide --request` also reads. Specified in docs/plan.md § The decision
// contract.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** One option per key; a null description leaves the key alone as the option's text. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

/** Levels lowest first; the answer is the expected level, zero-based. */
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

/** A yes/no question answered with the probability that it holds. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string | null; false?: string | null };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type QuestionType = Question["type"];

export interface Request {
  state: JsonValue;
  questions: Record<string, Question>;
}
