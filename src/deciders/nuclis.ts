// nuclis's decision models over the nuclis API (`nuclis-http.ts`). The
// models are whatever decision entries `GET /v1/models` lists, so a new one
// appears with no code change here; each entry's `nuclis.packs` says how
// to call it. The shapes read below are those of nuclis's
// docs/reference/api.md.

import type { Decision, Usage } from "../contract/answer.ts";
import {
  abortError,
  BATCH_LIMIT,
  type Decider,
  type ModelInfo,
} from "../contract/decider.ts";
import { DecideError, isDecideError } from "../contract/errors.ts";
import type { Request } from "../contract/request.ts";
import { validateAnswers } from "../contract/validate.ts";
import type { NuclisApi } from "./nuclis-http.ts";

const PROBE_TIMEOUT_MS = 5_000;

/** A packing model's bound per call: opening a model (under 0.2 s) and the backoff over a busy server. */
const PACKED_TIMEOUT_MS = 20_000;
/** How long nuclis lets a request wait for the GPU (`serve.timeout`). */
const QUEUE_MS = 300_000;
/** A non-packing model's time per sequence token, with room to spare (nuclis states about 4 ms). */
const MS_PER_TOKEN = 8;
/** The sequence's fixed part beyond the state and questions, in tokens. */
const SEQUENCE_OVERHEAD_TOKENS = 150;
/** Low on purpose, so token estimates err long. */
const CHARS_PER_TOKEN = 3;
/** Requests in flight per non-packing model: more only lengthen nuclis's queue. */
const SEQUENTIAL_IN_FLIGHT = 2;

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

/** How a decision model runs, from its `GET /v1/models` entry. */
export interface ModelProfile {
  /**
   * States of a request, and requests waiting together, share a GPU pass
   * (Laya). Otherwise each state is its own pass and costs time linear in
   * its tokens (clef-flash).
   */
  packs: boolean;
  /** The sequence budget in tokens, when the model is pulled. */
  maxLen?: number;
}

/** Each decision entry of `GET /v1/models` with its `nuclis` object. */
function decisionEntries(listing: unknown): { id: string; x: Json }[] {
  if (!isObject(listing) || !Array.isArray(listing.data))
    throw new DecideError("invalid_answer", "nuclis /models sent no list");
  const entries: { id: string; x: Json }[] = [];
  for (const entry of listing.data) {
    if (!isObject(entry) || typeof entry.id !== "string") continue;
    const x = entry.nuclis;
    if (isObject(x) && x.kind === "decision") entries.push({ id: entry.id, x });
  }
  return entries;
}

/** The decision entries of `GET /v1/models`. */
export function decisionModels(listing: unknown): ModelInfo[] {
  return decisionEntries(listing).map(({ id, x }) => {
    const reason =
      x.present !== true
        ? `not pulled: nuclis model pull ${id}`
        : typeof x.packs !== "boolean"
          ? "nuclis does not say how it runs (nuclis.packs)"
          : undefined;
    return {
      id,
      label: id,
      available: reason === undefined,
      ...(reason ? { reason } : {}),
    };
  });
}

/** The profile of every decision model whose entry says how it runs. */
export function modelProfiles(listing: unknown): Map<string, ModelProfile> {
  const profiles = new Map<string, ModelProfile>();
  for (const { id, x } of decisionEntries(listing)) {
    if (typeof x.packs !== "boolean") continue;
    const maxLen = finite(x.max_len);
    profiles.set(id, {
      packs: x.packs,
      ...(maxLen !== undefined ? { maxLen } : {}),
    });
  }
  return profiles;
}

/** A request's sequence length in tokens, estimated long, at most the model's budget. */
export function sequenceTokens(request: Request, maxLen?: number): number {
  const chars =
    JSON.stringify(request.state ?? "").length +
    JSON.stringify(request.questions).length;
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN) + SEQUENCE_OVERHEAD_TOKENS;
  return maxLen === undefined ? tokens : Math.min(tokens, maxLen);
}

/** Admits at most `limit` callers at once; the rest wait in arrival order. */
class Gate {
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.free = limit;
  }

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(abortError(signal));
        const admit = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          this.waiting.splice(this.waiting.indexOf(admit), 1);
          reject(abortError(signal));
        };
        this.waiting.push(admit);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}

/**
 * One gate per non-packing model and server, shared by every decider in
 * the process: the server builds deciders per request, and evals may run
 * side by side in one process.
 */
const gates = new Map<string, Gate>();
function gateFor(url: string, model: string): Gate {
  const key = `${url} ${model}`;
  let gate = gates.get(key);
  if (!gate) {
    gate = new Gate(SEQUENTIAL_IN_FLIGHT);
    gates.set(key, gate);
  }
  return gate;
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
    // A model without calibration buckets (clef-flash) sends "".
    if (x.bucket !== "") copy("bucket", "bucket");
    copy("answer_confidence", "answerConfidence");
    copy("sequence_tokens", "tokensRead");
    copy("state_kept", "stateKept");
    out[id] = { ...rest, debug };
  }
  return out;
}

/** Reads every result of `POST /v1/decisions`, one per request in order. */
export function decisionsFrom(
  requests: Request[],
  model: string,
  output: unknown,
): Decision[] {
  if (
    !isObject(output) ||
    !Array.isArray(output.results) ||
    output.results.length !== requests.length
  )
    throw new DecideError(
      "invalid_answer",
      `nuclis /decisions did not send ${requests.length} result${requests.length === 1 ? "" : "s"}`,
    );
  const timings: Decision["timings"] = { total: 0 };
  if (isObject(output.timings_ms)) {
    const t = output.timings_ms;
    const load = finite(t.load);
    const tokenize = finite(t.tokenize);
    const encode = finite(t.encode);
    if (load !== undefined) timings.load = load;
    if (tokenize !== undefined) timings.tokenize = tokenize;
    if (encode !== undefined) timings.encode = encode;
  }
  const answeredBy = typeof output.model === "string" ? output.model : model;
  return output.results.map((result: unknown, i) => {
    if (!isObject(result))
      throw new DecideError(
        "invalid_answer",
        "nuclis /decisions sent no result",
      );
    const decision: Decision = {
      decider: "nuclis",
      model: answeredBy,
      answers: validateAnswers(
        requests[i] as Request,
        answersFrom(result.answers),
      ),
      timings: { ...timings },
      // nuclis runs locally: a decision costs nothing.
      costUsd: 0,
    };
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
  });
}

/** Reads the one result of `POST /v1/decisions` into a Decision. */
export function decisionFrom(
  request: Request,
  model: string,
  output: unknown,
): Decision {
  return decisionsFrom([request], model, output)[0] as Decision;
}

export function nuclisDecider(api: NuclisApi): Decider {
  const probe = () => AbortSignal.timeout(PROBE_TIMEOUT_MS);
  // Read once per decider; a failed read is retried on the next ask.
  let listing: Promise<Map<string, ModelProfile>> | undefined;
  async function profile(
    model: string,
    signal?: AbortSignal,
  ): Promise<ModelProfile> {
    listing ??= api
      .models(signal ? AbortSignal.any([probe(), signal]) : probe())
      .then(modelProfiles);
    let profiles: Map<string, ModelProfile>;
    try {
      profiles = await listing;
    } catch (error) {
      listing = undefined;
      throw error;
    }
    const found = profiles.get(model);
    if (!found)
      throw new DecideError(
        "rejected",
        `nuclis lists no decision model ${model} that says how it runs (nuclis.packs)`,
      );
    return found;
  }
  /** One state per request; a non-packing model's calls pass its gate. */
  async function one(
    request: Request,
    model: string,
    signal: AbortSignal,
  ): Promise<Decision> {
    const send = async () =>
      decisionFrom(
        request,
        model,
        await api.decisions(
          { model, state: request.state, questions: request.questions },
          signal,
        ),
      );
    return (await profile(model, signal)).packs
      ? send()
      : gateFor(api.url, model).run(signal, send);
  }
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
    decide: (request, { model, signal }) => one(request, model, signal),
    async batches(model) {
      return (await profile(model)).packs;
    },
    // A packing model gets one call for many states (the caller groups
    // requests by questions); any other, one state at a time.
    async decideBatch(requests, { model, signal }) {
      const questions = requests[0]?.questions;
      if (!questions) return [];
      if (!(await profile(model, signal)).packs) {
        const out: Decision[] = [];
        for (const request of requests)
          out.push(await one(request, model, signal));
        return out;
      }
      const output = await api.decisions(
        { model, states: requests.map((r) => r.state), questions },
        signal,
      );
      return decisionsFrom(requests, model, output);
    },
    // A packing model: per call of up to BATCH_LIMIT states. Any other: the
    // queue's wait plus every state's tokens. Unknown (nuclis unreachable):
    // the short bound, since the call will fail fast anyway.
    async timeoutMs(requests, model) {
      let found: ModelProfile;
      try {
        found = await profile(model);
      } catch {
        return PACKED_TIMEOUT_MS;
      }
      if (found.packs)
        return (
          PACKED_TIMEOUT_MS *
          Math.max(1, Math.ceil(requests.length / BATCH_LIMIT))
        );
      const tokens = requests.reduce(
        (sum, r) => sum + sequenceTokens(r, found.maxLen),
        0,
      );
      return QUEUE_MS + tokens * MS_PER_TOKEN;
    },
  };
}
