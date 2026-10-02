// nuclis's decision models, reached through a transport. The models are
// whatever decision entries nuclis lists, so a new one appears with no code
// change here. The output shapes read below are those `nuclis decide
// --json --explain` and `nuclis model ls --json` print
// (nuclis docs/reference/laya.md § `nuclis decide`).

import type { Answers, Decision, Usage } from "../contract/answer.ts";
import type { Decider, ModelInfo } from "../contract/decider.ts";
import { DecideError, isDecideError } from "../contract/errors.ts";
import type { Request } from "../contract/request.ts";
import { validateAnswers } from "../contract/validate.ts";

/** How the decider reaches nuclis. Each method returns the command's parsed JSON. */
export interface NuclisTransport {
  kind: "spawn";
  version(signal: AbortSignal): Promise<string>;
  /** The body `nuclis model ls --json` prints. */
  models(signal: AbortSignal): Promise<unknown>;
  /** The body `nuclis decide --request - --json --explain` prints. */
  decide(
    request: Request,
    model: string,
    signal: AbortSignal,
  ): Promise<unknown>;
}

const PROBE_TIMEOUT_MS = 5_000;

/** A field longer than this (about 100 tokens, a fifth of Laya's 512) is bulky context. */
const BULKY_CHARS = 400;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * A short-budget model cuts the state at its tail. Bulky top-level fields
 * move to the end, smallest first, so a cut loses bulk before the
 * situational facts; the other fields keep their order.
 */
export function bulkLast(request: Request): Request {
  const { state } = request;
  if (!isObject(state)) return request;
  const entries = Object.entries(state).map(([key, value], index) => ({
    key,
    value,
    size: JSON.stringify(value).length,
    index,
  }));
  const short = entries.filter((e) => e.size <= BULKY_CHARS);
  const bulky = entries
    .filter((e) => e.size > BULKY_CHARS)
    .sort((a, b) => a.size - b.size || a.index - b.index);
  return {
    ...request,
    state: Object.fromEntries(
      [...short, ...bulky].map((e) => [e.key, e.value]),
    ),
  };
}

/** The decision entries of `nuclis model ls --json`. */
export function decisionModels(listing: unknown): ModelInfo[] {
  if (!isObject(listing) || !Array.isArray(listing.catalog))
    throw new DecideError(
      "invalid_answer",
      "nuclis model ls printed no catalog",
    );
  const models: ModelInfo[] = [];
  for (const entry of listing.catalog) {
    if (!isObject(entry) || entry.kind !== "decision") continue;
    if (typeof entry.name !== "string") continue;
    const present = entry.status === "present";
    models.push({
      id: entry.name,
      label: entry.name,
      available: present,
      ...(present
        ? {}
        : { reason: `not pulled: nuclis model pull ${entry.name}` }),
    });
  }
  return models;
}

/** Moves each answer's `nuclis` object into the contract's `debug` fields. */
function answersFrom(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  const out: Json = {};
  for (const [id, answer] of Object.entries(raw)) {
    if (!isObject(answer) || !isObject(answer.nuclis)) {
      out[id] = answer;
      continue;
    }
    const { nuclis: x, ...rest } = answer;
    const debug: Json = {};
    const copy = (from: string, to: string) => {
      if (x[from] !== undefined) debug[to] = x[from];
    };
    copy("logits", "logits");
    copy("temperature", "temperature");
    copy("bucket", "bucket");
    copy("answer_confidence", "answerConfidence");
    copy("sequence_tokens", "tokensRead");
    copy("state_kept", "stateKept");
    out[id] = { ...rest, debug };
  }
  return out;
}

/** Reads the one result of `nuclis decide --json` into a Decision. */
export function decisionFrom(
  request: Request,
  model: string,
  output: unknown,
): Decision {
  if (
    !isObject(output) ||
    !Array.isArray(output.results) ||
    output.results.length !== 1
  )
    throw new DecideError(
      "invalid_answer",
      "nuclis decide did not print exactly one result",
    );
  const result: unknown = output.results[0];
  if (!isObject(result))
    throw new DecideError("invalid_answer", "nuclis decide printed no result");
  const answers: Answers = validateAnswers(
    request,
    answersFrom(result.answers),
  );
  const decision: Decision = {
    decider: "nuclis",
    model: typeof output.model === "string" ? output.model : model,
    answers,
    timings: { total: 0 },
    // nuclis runs locally: a decision costs nothing.
    costUsd: 0,
  };
  if (isObject(output.timings_ms)) {
    const t = output.timings_ms;
    const load = finite(t.load);
    const tokenize = finite(t.tokenize);
    const encode = finite(t.encode);
    if (load !== undefined) decision.timings.load = load;
    if (tokenize !== undefined) decision.timings.tokenize = tokenize;
    if (encode !== undefined) decision.timings.encode = encode;
  }
  if (isObject(result.usage)) {
    const inputTokens = finite(result.usage.input_tokens);
    const outputTokens = finite(result.usage.output_tokens);
    if (inputTokens !== undefined && outputTokens !== undefined) {
      const usage: Usage = { inputTokens, outputTokens };
      decision.usage = usage;
    }
  }
  if (isObject(result.nuclis)) {
    const stateTokens = finite(result.nuclis.state_tokens);
    const truncated = result.nuclis.truncated;
    decision.debug = {
      ...(stateTokens !== undefined ? { stateTokens } : {}),
      ...(typeof truncated === "boolean" ? { truncated } : {}),
    };
  }
  return decision;
}

export function nuclisDecider(transport: NuclisTransport): Decider {
  const probe = () => AbortSignal.timeout(PROBE_TIMEOUT_MS);
  return {
    id: "nuclis",
    label: "nuclis",
    async models() {
      return decisionModels(await transport.models(probe()));
    },
    async status() {
      try {
        const version = await transport.version(probe());
        return { configured: true, reachable: true, version };
      } catch (error) {
        const reason = isDecideError(error) ? error.message : String(error);
        return isDecideError(error) && error.code === "unconfigured"
          ? { configured: false, reason }
          : { configured: true, reachable: false, reason };
      }
    },
    prepare: (request) => bulkLast(request),
    async decide(request, { model, signal }) {
      const output = await transport.decide(request, model, signal);
      return decisionFrom(request, model, output);
    },
  };
}
