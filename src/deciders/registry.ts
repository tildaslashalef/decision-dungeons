// The deciders the server offers, built from the effective config. `rule`
// is listed here but answered by the dungeon in play: each dungeon owns its
// baseline, and this module never imports one.

import type { Decider } from "../contract/decider.ts";
import { DecideError } from "../contract/errors.ts";
import { nuclisDecider } from "./nuclis.ts";
import { spawnTransport } from "./nuclis-spawn.ts";
import { randomDecider } from "./random.ts";
import { typesafeDecider } from "./typesafe.ts";

export const DECIDER_IDS = ["nuclis", "typesafe", "rule", "random"] as const;
export type DeciderId = (typeof DECIDER_IDS)[number];

export function isDeciderId(value: unknown): value is DeciderId {
  return DECIDER_IDS.includes(value as DeciderId);
}

/** Per-decider bound on one decision, in milliseconds. */
export const DECIDE_TIMEOUT_MS: Record<DeciderId, number> = {
  // A cold Metal start compiles pipelines; a 1,024-token state encodes in about 0.3 s.
  nuclis: 20_000,
  typesafe: 15_000,
  rule: 2_000,
  random: 2_000,
};

export interface DeciderSettings {
  nuclisBin: string;
  backend?: "cpu" | "metal";
  typesafeKey?: string;
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
      spawnTransport({
        bin: settings.nuclisBin,
        ...(settings.backend ? { backend: settings.backend } : {}),
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
