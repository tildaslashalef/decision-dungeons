// The deciders the server offers, built from the effective config. `rule`
// is listed here but answered by the dungeon in play: each dungeon owns its
// baseline, and this module never imports one.

import type { Decider } from "../contract/decider.ts";
import { DecideError } from "../contract/errors.ts";
import { nuclisDecider } from "./nuclis.ts";
import { nuclisHttp } from "./nuclis-http.ts";
import { randomDecider } from "./random.ts";
import { typesafeDecider } from "./typesafe.ts";

export const DECIDER_IDS = ["nuclis", "typesafe", "rule", "random"] as const;
export type DeciderId = (typeof DECIDER_IDS)[number];

export function isDeciderId(value: unknown): value is DeciderId {
  return DECIDER_IDS.includes(value as DeciderId);
}

/** Per-decider bound on one decision, in milliseconds. */
export const DECIDE_TIMEOUT_MS: Record<DeciderId, number> = {
  // Covers opening a model (under 0.2 s) and the backoff over a busy server.
  nuclis: 20_000,
  typesafe: 15_000,
  rule: 2_000,
  random: 2_000,
};

export interface DeciderSettings {
  /** The nuclis API's base URL, ending in `/v1`. */
  nuclisUrl: string;
  typesafeKey?: string;
  /** Injected so tests reach neither nuclis nor TypeSafe. */
  fetch?: typeof fetch;
}

/** Stands in for the dungeon's baseline in listings; deciding needs the dungeon. */
const ruleListing: Decider = {
  id: "rule",
  label: "Fixed rule",
  models: async () => [{ id: "baseline", label: "Baseline", available: true }],
  status: async () => ({ configured: true, reachable: true }),
  decide: async () => {
    throw new DecideError("rejected", "the rule decider needs a dungeon");
  },
};

export function createDeciders(
  settings: DeciderSettings,
): Record<DeciderId, Decider> {
  return {
    nuclis: nuclisDecider(
      nuclisHttp({
        url: settings.nuclisUrl,
        ...(settings.fetch ? { fetch: settings.fetch } : {}),
      }),
    ),
    typesafe: typesafeDecider({
      apiKey: settings.typesafeKey,
      ...(settings.fetch ? { fetch: settings.fetch } : {}),
    }),
    rule: ruleListing,
    random: randomDecider(),
  };
}
