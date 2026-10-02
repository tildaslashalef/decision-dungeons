// The nuclis API client, the one way this project reaches nuclis. The
// contract is nuclis's docs/reference/api.md; this module reads nothing but
// what those routes answer. `fetch` is injected so tests never need a
// running server.

import { abortError } from "../contract/decider.ts";
import { DecideError } from "../contract/errors.ts";
import type { Question } from "../contract/request.ts";

export const DEFAULT_NUCLIS_URL = "http://127.0.0.1:8000/v1";

/** `529 busy` or `timeout`: retried this many times, backing off from the first delay. */
const RETRIES = 4;
const FIRST_BACKOFF_MS = 100;

/** The body of `POST /v1/decisions`: one state or many (at most 64), one question set. */
export type DecisionsBody = {
  model: string;
  questions: Record<string, Question>;
} & ({ state: unknown } | { states: unknown[] });

/** The routes this project uses; each resolves to the route's parsed JSON body. */
export interface NuclisApi {
  url: string;
  health(signal: AbortSignal): Promise<unknown>;
  models(signal: AbortSignal): Promise<unknown>;
  /** `?explain=1`, so each answer carries the tokens it read and the state it kept. */
  decisions(body: DecisionsBody, signal: AbortSignal): Promise<unknown>;
}

export interface NuclisHttpSettings {
  /** The API's base URL, ending in `/v1`. */
  url: string;
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `{ error: { code, message } }` body every nuclis error carries. */
function errorText(body: unknown, status: number): string {
  if (isObject(body) && isObject(body.error)) {
    const { code, message } = body.error;
    if (typeof code === "string" && typeof message === "string")
      return `${code}: ${message}`;
  }
  return `HTTP ${status}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function nuclisHttp(settings: NuclisHttpSettings): NuclisApi {
  const base = settings.url.replace(/\/+$/, "");
  const send = settings.fetch ?? fetch;

  async function call(
    path: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await send(`${base}${path}`, { ...init, signal });
      } catch (error) {
        if (signal.aborted) throw abortError(signal);
        const code = (error as { code?: unknown } | null)?.code;
        throw new DecideError(
          "unavailable",
          code === "ConnectionRefused"
            ? `nuclis serve is not running at ${base}; start it with nuclis serve`
            : `could not reach nuclis at ${base}`,
        );
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        if (signal.aborted) throw abortError(signal);
        throw new DecideError(
          "invalid_answer",
          `nuclis ${path} sent malformed JSON (HTTP ${res.status})`,
        );
      }
      if (res.ok) return body;
      const text = `nuclis ${path}: ${errorText(body, res.status)}`;
      if (res.status === 529) {
        if (attempt >= RETRIES) throw new DecideError("unavailable", text);
        await sleep(FIRST_BACKOFF_MS * 2 ** attempt, signal);
        continue;
      }
      throw new DecideError(
        res.status >= 500 ? "unavailable" : "rejected",
        text,
      );
    }
  }

  return {
    url: base,
    health: (signal) => call("/health", { method: "GET" }, signal),
    models: (signal) => call("/models", { method: "GET" }, signal),
    decisions: (body, signal) =>
      call(
        "/decisions?explain=1",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        signal,
      ),
  };
}
