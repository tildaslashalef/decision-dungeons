// TypeSafe's hosted Jev over HTTPS. The key lives on the server and never
// appears in an error, a log line, or a response.

import type { Decision } from "../contract/answer.ts";
import type { Decider, Pricing } from "../contract/decider.ts";
import { abortError } from "../contract/decider.ts";
import { DecideError } from "../contract/errors.ts";
import { validateAnswers } from "../contract/validate.ts";

export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

/** Jev's published price. */
export const JEV_PRICING: Pricing = {
  inputPerMillionUsd: 0.042,
  outputPerMillionUsd: 0,
  source: "https://typesafe.ai/blog/introducing-system-one-models-and-jev",
};

export interface TypesafeSettings {
  apiKey: string | undefined;
  /** Injected so tests never reach the network. */
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function httpError(status: number): DecideError {
  if (status === 401 || status === 403)
    return new DecideError("rejected", "TypeSafe rejected the API key");
  if (status === 429)
    return new DecideError("rejected", "TypeSafe's rate limit was reached");
  if (status >= 500)
    return new DecideError("unavailable", `TypeSafe returned HTTP ${status}`);
  return new DecideError("rejected", `TypeSafe returned HTTP ${status}`);
}

export function typesafeDecider(settings: TypesafeSettings): Decider {
  const { apiKey } = settings;
  const send = settings.fetch ?? fetch;
  const unconfigured = "Set a TypeSafe API key on the config page";
  return {
    id: "typesafe",
    label: "TypeSafe Jev",
    models: async () => [
      {
        id: JEV_MODEL,
        label: "Jev (latest)",
        available: !!apiKey,
        ...(apiKey ? {} : { reason: unconfigured }),
      },
    ],
    status: async () =>
      apiKey
        ? { configured: true, pricing: JEV_PRICING }
        : { configured: false, reason: unconfigured, pricing: JEV_PRICING },
    async decide(request, { model, signal }) {
      if (!apiKey) throw new DecideError("unconfigured", unconfigured);
      // Jev's protocol has no images; dropping them would change the question.
      if (request.images)
        throw new DecideError("rejected", "TypeSafe Jev takes no images");
      let res: Response;
      try {
        res = await send(TYPESAFE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, ...request }),
          signal,
        });
      } catch {
        if (signal.aborted) throw abortError(signal);
        throw new DecideError("unavailable", "Could not reach TypeSafe");
      }
      if (!res.ok) throw httpError(res.status);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        if (signal.aborted) throw abortError(signal);
        throw new DecideError("invalid_answer", "TypeSafe sent malformed JSON");
      }
      if (!isObject(body))
        throw new DecideError("invalid_answer", "TypeSafe sent no answers");
      const decision: Decision = {
        decider: "typesafe",
        model: typeof body.model === "string" ? body.model : model,
        answers: validateAnswers(request, body.answers),
        timings: { total: 0 },
      };
      const usage = body.usage;
      if (
        isObject(usage) &&
        Number.isFinite(usage.input_tokens) &&
        Number.isFinite(usage.output_tokens)
      ) {
        const inputTokens = usage.input_tokens as number;
        const outputTokens = usage.output_tokens as number;
        decision.usage = { inputTokens, outputTokens };
        decision.costUsd =
          (inputTokens * JEV_PRICING.inputPerMillionUsd +
            outputTokens * JEV_PRICING.outputPerMillionUsd) /
          1e6;
      }
      return decision;
    },
  };
}
