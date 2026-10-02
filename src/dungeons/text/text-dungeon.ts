// One builder for the text dungeons: each case is one decision, asked
// with its level's questions about the case's input and scored against the
// case's known answers. A dungeon supplies its levels, the request state a
// case becomes, a baseline rule that reads only the request, and a short
// description of a case for the records.

import type { Answer, Answers } from "../../contract/answer.ts";
import type { Decider } from "../../contract/decider.ts";
import { DecideError } from "../../contract/errors.ts";
import type { JsonValue, Question, Request } from "../../contract/request.ts";
import type { DecisionRecord, Dungeon, Level, Outcome } from "../dungeon.ts";
import {
  type CaseSet,
  type CaseSetRef,
  pickCases,
  type TextCase,
  type Truth,
} from "./cases.ts";

/** Cases a run asks. */
export const CASES_PER_RUN = 20;
/** A run passes with at least this share of cases fully right. */
export const PASS_ACCURACY = 0.9;

export interface TextLevel extends Level {
  questions: Record<string, Question>;
}

export interface TextSpec {
  id: string;
  title: string;
  description: string;
  levels: TextLevel[];
  /** The request's state for a case: what the decider reads. */
  state(c: TextCase): JsonValue;
  /** The baseline's answers, read off the request alone. */
  rule(request: Request): Answers;
  /** A few words naming the case in records. */
  summary(c: TextCase): string;
}

export interface TextRun {
  seed: number;
  level: string;
  set: CaseSetRef;
  cases: TextCase[];
  /** The case being asked; equals cases.length when the run is over. */
  index: number;
  answers: Answers[];
  records: DecisionRecord[];
  /** Sum of (p − truth)² over noul answers, and how many. */
  brier: { sum: number; n: number };
  /** Sum of |score − truth| over score answers, and how many. */
  scoreError: { sum: number; n: number };
}

/** The value an answer gives, in the truth's terms. */
export function answerValue(answer: Answer | undefined): Truth | undefined {
  if (!answer) return undefined;
  if (answer.type === "noul") return answer.noul >= 0.5;
  if (answer.type === "choice") return answer.choice;
  return Math.round(answer.score);
}

const shown = (value: Truth | undefined) =>
  value === undefined
    ? "—"
    : value === true
      ? "yes"
      : value === false
        ? "no"
        : String(value);

export function textDungeon(spec: TextSpec): Dungeon<TextRun> {
  const levelOf = (id: string) => spec.levels.find((l) => l.id === id);
  const rule: Decider = {
    id: "rule",
    label: "Fixed rule",
    models: async () => [
      { id: "baseline", label: "Baseline", available: true },
    ],
    status: async () => ({ configured: true, reachable: true }),
    async decide(request) {
      try {
        return {
          decider: "rule",
          model: "baseline",
          answers: spec.rule(request),
          timings: { total: 0 },
        };
      } catch (error) {
        throw new DecideError(
          "rejected",
          `the ${spec.id} rule cannot read this request: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    levels: spec.levels.map(({ id, title, description }) => ({
      id,
      title,
      description,
    })),
    caseSets: true,
    create(seed, level, options = {}) {
      if (!levelOf(level)) throw new Error(`${spec.id} has no level ${level}`);
      const set: CaseSet | undefined = options.cases;
      if (!set || set.dungeon !== spec.id)
        throw new Error(
          `${spec.id} plays from a case set; run \`bun run seed\` to write one`,
        );
      const cases = pickCases(set, level, seed, CASES_PER_RUN);
      if (!cases.length)
        throw new Error(`case set ${set.name} has no ${level} cases`);
      return {
        seed,
        level,
        set: { name: set.name, hash: set.hash },
        cases,
        index: 0,
        answers: [],
        records: [],
        brier: { sum: 0, n: 0 },
        scoreError: { sum: 0, n: 0 },
      };
    },
    observe(run) {
      const c = run.cases[run.index];
      const level = levelOf(run.level);
      if (!c || !level) throw new Error(`the ${spec.id} run is over`);
      return { request: { state: spec.state(c), questions: level.questions } };
    },
    observeAll(run) {
      const level = levelOf(run.level);
      if (!level) return [];
      return run.cases.slice(run.index).map((c) => ({
        request: { state: spec.state(c), questions: level.questions },
      }));
    },
    apply(run, answers: Answers) {
      const c = run.cases[run.index];
      if (!c) return;
      let correct = true;
      const parts: string[] = [];
      for (const [id, truth] of Object.entries(c.truth)) {
        const answer = answers[id];
        const value = answerValue(answer);
        if (value !== truth) correct = false;
        if (answer?.type === "noul" && typeof truth === "boolean") {
          run.brier.sum += (answer.noul - (truth ? 1 : 0)) ** 2;
          run.brier.n++;
        }
        if (answer?.type === "score" && typeof truth === "number") {
          run.scoreError.sum += Math.abs(answer.score - truth);
          run.scoreError.n++;
        }
        parts.push(
          value === truth
            ? `${id} ${shown(value)}`
            : `${id} ${shown(value)} (expected ${shown(truth)})`,
        );
      }
      run.answers.push(answers);
      run.records.push({
        index: run.index,
        summary: `${spec.summary(c)}: ${parts.join(", ")}`,
        correct,
      });
      run.index++;
    },
    step() {},
    outcome(run): Outcome {
      const finished = run.index >= run.cases.length;
      const decided = run.records.length;
      const correct = run.records.filter((r) => r.correct).length;
      const accuracy = decided ? correct / decided : undefined;
      return {
        finished,
        ...(finished ? { passed: (accuracy ?? 0) >= PASS_ACCURACY } : {}),
        violations: 0,
        metrics: {
          cases: run.cases.length,
          decided,
          correct,
          ...(accuracy !== undefined ? { accuracy } : {}),
          ...(run.brier.n ? { brier: run.brier.sum / run.brier.n } : {}),
          ...(run.scoreError.n
            ? { score_mae: run.scoreError.sum / run.scoreError.n }
            : {}),
        },
        records: run.records,
      };
    },
    rule,
  };
}
