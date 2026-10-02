// nuclis's decision models over the nuclis API (`nuclis-http.ts`). The
// models are whatever decision entries `GET /v1/models` lists, so a new one
// appears with no code change here. The shapes read below are those of
// nuclis's docs/reference/api.md.

import type { Answers, Decision, Usage } from "../contract/answer.ts";
import type { Decider, ModelInfo } from "../contract/decider.ts";
import { DecideError, isDecideError } from "../contract/errors.ts";
import type { Request } from "../contract/request.ts";
import { validateAnswers } from "../contract/validate.ts";
import type { NuclisApi } from "./nuclis-http.ts";

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

/** The decision entries of `GET /v1/models`. */
export function decisionModels(listing: unknown): ModelInfo[] {
  if (!isObject(listing) || !Array.isArray(listing.data))
    throw new DecideError("invalid_answer", "nuclis /models sent no list");
  const models: ModelInfo[] = [];
  for (const entry of listing.data) {
    if (!isObject(entry) || typeof entry.id !== "string") continue;
    const x = entry.nuclis;
    if (!isObject(x) || x.kind !== "decision") continue;
    const present = x.present === true;
    models.push({
      id: entry.id,
      label: entry.id,
      available: present,
      ...(present
        ? {}
        : { reason: `not pulled: nuclis model pull ${entry.id}` }),
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

/** Reads the one result of `POST /v1/decisions` into a Decision. */
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
      "nuclis /decisions did not send exactly one result",
    );
  const result: unknown = output.results[0];
  if (!isObject(result))
    throw new DecideError("invalid_answer", "nuclis /decisions sent no result");
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

export function nuclisDecider(api: NuclisApi): Decider {
  const probe = () => AbortSignal.timeout(PROBE_TIMEOUT_MS);
  return {
    id: "nuclis",
    label: "nuclis",
    async models() {
      return decisionModels(await api.models(probe()));
    },
    async status() {
      try {
        const health = await api.health(probe());
        const version =
          isObject(health) && typeof health.version === "string"
            ? `nuclis ${health.version}`
            : undefined;
        return {
          configured: true,
          reachable: true,
          ...(version ? { version } : {}),
        };
      } catch (error) {
        const reason = isDecideError(error) ? error.message : String(error);
        return { configured: true, reachable: false, reason };
      }
    },
    prepare: (request) => bulkLast(request),
    async decide(request, { model, signal }) {
      const output = await api.decisions(
        { model, state: request.state, questions: request.questions },
        signal,
      );
      return decisionFrom(request, model, output);
    },
  };
}
