// A whole run, headless: turns until the dungeon says it is finished, and
// the one result object both the CLI and the UI render.

import type { Decision } from "../contract/answer.ts";
import { isDecideError } from "../contract/errors.ts";
import type { Request } from "../contract/request.ts";
import type { AnyDungeon, Outcome, RunOptions } from "./dungeon.ts";
import type { CaseSetRef } from "./text/cases.ts";
import { playTurn } from "./turn.ts";

export interface RunResult {
  dungeon: string;
  level: string;
  seed: number;
  decider: string;
  model: string;
  /** Whether the dungeon's safety nets were off; false for dungeons without them. */
  evaluation: boolean;
  /** The case set a text dungeon played. */
  caseSet?: CaseSetRef;
  outcome: Outcome;
  /** Decisions a decider was asked; the rest resolved locally. */
  asked: number;
  /** Mean decider time per asked decision, ms; absent when none was asked. */
  meanDecideMs?: number;
  inputTokens?: number;
  /** Decisions whose state the model cut to fit its budget; absent when no decider reported it. */
  truncated?: number;
  costUsd?: number;
  /** Why the run stopped early, when a decision failed. */
  error?: { code: string; message: string };
}

export async function runEpisode(
  dungeon: AnyDungeon,
  level: string,
  seed: number,
  decider: { id: string; model: string },
  decide: (request: Request) => Promise<Decision>,
  options: RunOptions = {},
): Promise<RunResult> {
  const evaluation = !!options.evaluation && !!dungeon.evaluation;
  const run = dungeon.create(seed, level, {
    evaluation,
    ...(options.cases ? { cases: options.cases } : {}),
  });
  let outcome = dungeon.outcome(run);
  let asked = 0;
  let decideMs = 0;
  let inputTokens: number | undefined;
  let truncated: number | undefined;
  let costUsd: number | undefined;
  let error: RunResult["error"];
  while (!outcome.finished) {
    try {
      const turn = await playTurn(dungeon, run, decide);
      outcome = turn.outcome;
      const d = turn.decision;
      if (!d) continue;
      asked++;
      decideMs += d.timings.total;
      if (d.usage) inputTokens = (inputTokens ?? 0) + d.usage.inputTokens;
      if (d.debug?.truncated !== undefined)
        truncated = (truncated ?? 0) + (d.debug.truncated ? 1 : 0);
      if (d.costUsd !== undefined) costUsd = (costUsd ?? 0) + d.costUsd;
    } catch (e) {
      error = isDecideError(e)
        ? { code: e.code, message: e.message }
        : {
            code: "unavailable",
            message: e instanceof Error ? e.message : String(e),
          };
      break;
    }
  }
  return {
    dungeon: dungeon.id,
    level,
    seed,
    decider: decider.id,
    model: decider.model,
    evaluation,
    ...(dungeon.caseSets && options.cases
      ? { caseSet: { name: options.cases.name, hash: options.cases.hash } }
      : {}),
    outcome,
    asked,
    ...(asked ? { meanDecideMs: Math.round(decideMs / asked) } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(error ? { error } : {}),
  };
}
