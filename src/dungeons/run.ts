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
  /** Decisions a cascade's judge answered; absent for other deciders. */
  escalated?: number;
  costUsd?: number;
  /** Why the run stopped early, when a decision failed. */
  error?: { code: string; message: string };
  /** The whole run's wall time on this machine, ms. */
  wallMs: number;
  /** Set when the run's decisions were sent together (`Dungeon.observeAll`). */
  batched?: true;
}

/** Decides many independent requests, one decision each, in order. */
export type DecideManyFn = (requests: Request[]) => Promise<Decision[]>;

export async function runEpisode(
  dungeon: AnyDungeon,
  level: string,
  seed: number,
  decider: { id: string; model: string },
  decide: (request: Request) => Promise<Decision>,
  options: RunOptions = {},
  decideMany?: DecideManyFn,
): Promise<RunResult> {
  const started = performance.now();
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
  let escalated: number | undefined;
  let error: RunResult["error"];
  const tally = (d: Decision | undefined) => {
    if (!d) return;
    asked++;
    decideMs += d.timings.total;
    if (d.usage) inputTokens = (inputTokens ?? 0) + d.usage.inputTokens;
    if (d.debug?.truncated !== undefined)
      truncated = (truncated ?? 0) + (d.debug.truncated ? 1 : 0);
    if (d.costUsd !== undefined) costUsd = (costUsd ?? 0) + d.costUsd;
    if (d.debug?.cascade)
      escalated = (escalated ?? 0) + (d.debug.cascade.escalated ? 1 : 0);
  };
  const failure = (e: unknown): RunResult["error"] =>
    isDecideError(e)
      ? { code: e.code, message: e.message }
      : {
          code: "unavailable",
          message: e instanceof Error ? e.message : String(e),
        };
  const batched = !!decideMany && !!dungeon.observeAll;
  if (batched && decideMany && dungeon.observeAll) {
    const observations = dungeon.observeAll(run);
    const ask = observations.filter(
      (o) => Object.keys(o.request.questions).length > 0,
    );
    try {
      const decisions = await decideMany(ask.map((o) => o.request));
      let k = 0;
      for (const o of observations) {
        const d = ask.includes(o) ? decisions[k++] : undefined;
        dungeon.apply(run, { ...o.resolved, ...d?.answers });
        dungeon.advance?.(run);
        tally(d);
      }
    } catch (e) {
      error = failure(e);
    }
    outcome = dungeon.outcome(run);
  }
  while (!outcome.finished && !batched) {
    try {
      const turn = await playTurn(dungeon, run, decide);
      outcome = turn.outcome;
      tally(turn.decision);
    } catch (e) {
      error = failure(e);
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
    ...(escalated !== undefined ? { escalated } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(error ? { error } : {}),
    wallMs: Math.round(performance.now() - started),
    ...(batched ? { batched: true as const } : {}),
  };
}
