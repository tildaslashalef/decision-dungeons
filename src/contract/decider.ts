// The interface every decider implements, and the one call path that
// prepares, times, and validates a decision. Deciders know no dungeon.

import type { Decision } from "./answer.ts";
import { DecideError, isDecideError } from "./errors.ts";
import type { Request } from "./request.ts";
import { validateAnswers } from "./validate.ts";

export interface ModelInfo {
  id: string;
  label: string;
  available: boolean;
  /** Why the model cannot be used, when it cannot. */
  reason?: string;
}

export interface Pricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  source: string;
}

export interface DeciderStatus {
  configured: boolean;
  /** Absent when the decider was not probed (a hosted API is not called to check). */
  reachable?: boolean;
  /** Why the decider cannot be used, when it cannot. */
  reason?: string;
  version?: string;
  pricing?: Pricing;
}

export interface DecideOptions {
  model: string;
  signal: AbortSignal;
  /** The run's seed, for deciders whose answers are random. */
  seed?: number;
}

export interface Decider {
  id: string;
  label: string;
  models(): Promise<ModelInfo[]>;
  status(): Promise<DeciderStatus>;
  /** Rewrites a request for this decider's budget; pure. */
  prepare?(request: Request, model: string): Request;
  decide(request: Request, options: DecideOptions): Promise<Decision>;
}

/**
 * Prepares, sends, and validates one decision. Every caller (server, CLI,
 * tests) goes through here, so no path trusts a decider's answers.
 */
export async function decideWith(
  decider: Decider,
  request: Request,
  options: DecideOptions,
): Promise<Decision> {
  const sent = decider.prepare
    ? decider.prepare(request, options.model)
    : request;
  const started = performance.now();
  let decision: Decision;
  try {
    decision = await decider.decide(sent, options);
  } catch (error) {
    if (isDecideError(error)) throw error;
    if (options.signal.aborted) throw abortError(options.signal);
    throw new DecideError(
      "unavailable",
      `${decider.label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const answers = validateAnswers(sent, decision.answers);
  return {
    ...decision,
    answers,
    timings: {
      ...decision.timings,
      total: Math.round(performance.now() - started),
    },
    debug: { ...decision.debug, request: sent },
  };
}

/** The typed error for an aborted signal: a timeout, or the caller giving up. */
export function abortError(signal: AbortSignal): DecideError {
  const reason: unknown = signal.reason;
  return reason instanceof DOMException && reason.name === "TimeoutError"
    ? new DecideError("timeout", "the decider did not answer in time")
    : new DecideError("unavailable", "the decision was cancelled");
}
