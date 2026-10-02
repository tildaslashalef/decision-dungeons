// Against a running `nuclis serve` (NUCLIS_URL, default 127.0.0.1:8000/v1).
// Skipped when `GET /v1/health` does not answer, so the default run needs
// no server.

import { describe, expect, test } from "bun:test";
import { decideWith } from "../src/contract/decider.ts";
import { nuclisDecider } from "../src/deciders/nuclis.ts";
import { DEFAULT_NUCLIS_URL, nuclisHttp } from "../src/deciders/nuclis-http.ts";
import { crossing } from "../src/dungeons/crossing/crossing.ts";

const url = process.env.NUCLIS_URL || DEFAULT_NUCLIS_URL;
const up = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })
  .then((res) => res.ok)
  .catch(() => false);

describe.skipIf(!up)(`nuclis serve at ${url}`, () => {
  const decider = nuclisDecider(nuclisHttp({ url }));

  test("is reachable and lists laya-multilingual", async () => {
    expect(await decider.status()).toMatchObject({ reachable: true });
    const models = await decider.models();
    expect(models.find((m) => m.id === "laya-multilingual")).toMatchObject({
      available: true,
    });
  });

  test("answers a Crossing request with valid, explained answers", async () => {
    const { request } = crossing.observe(crossing.create(1, "mixed"));
    const decision = await decideWith(decider, request, {
      model: "laya-multilingual",
      signal: AbortSignal.timeout(20_000),
    });
    expect(decision.model).toBe("laya-multilingual");
    const motion = decision.answers.motion;
    expect(motion?.type).toBe("choice");
    expect(motion?.debug?.logits).toHaveLength(2);
    expect(decision.debug?.truncated).toBe(false);
    expect(decision.timings.encode).toBeGreaterThan(0);
  });
});
