import { afterEach, describe, expect, test } from "bun:test";
import { decideWith } from "../src/contract/decider.ts";
import type { Request } from "../src/contract/request.ts";
import { bulkLast, nuclisDecider } from "../src/deciders/nuclis.ts";
import { spawnTransport } from "../src/deciders/nuclis-spawn.ts";
import { randomDecider } from "../src/deciders/random.ts";
import {
  JEV_MODEL,
  TYPESAFE_URL,
  typesafeDecider,
} from "../src/deciders/typesafe.ts";
import {
  decideOutput,
  type FakeNuclis,
  fakeNuclis,
  modelListing,
  print,
} from "./fake-nuclis.ts";

const request: Request = {
  state: { signal: "red", bumper_to_line: 1.9 },
  questions: {
    motion: {
      type: "choice",
      instructions: "Drive or stop?",
      criteria: { drive: "keep moving", stop: "brake now" },
    },
  },
};
const options = (model = "laya") => ({
  model,
  signal: AbortSignal.timeout(5000),
});

describe("nuclis over spawn", () => {
  let fake: FakeNuclis | undefined;
  afterEach(() => fake?.remove());

  const decider = (f: FakeNuclis, backend?: "cpu" | "metal") =>
    nuclisDecider(
      spawnTransport({ bin: f.bin, ...(backend ? { backend } : {}) }),
    );

  test("pipes the request and reads the answers, timings, and debug fields", async () => {
    fake = fakeNuclis({ decide: print(decideOutput("stop")) });
    const decision = await decideWith(decider(fake, "cpu"), request, options());
    expect(fake.args()).toBe(
      "decide --request - --json --explain --model laya --backend cpu",
    );
    expect(JSON.parse(fake.stdin())).toEqual(request);
    expect(decision.decider).toBe("nuclis");
    expect(decision.model).toBe("laya");
    expect(decision.answers.motion).toEqual({
      type: "choice",
      choice: "stop",
      probabilities: { drive: 0.4016, stop: 0.5984 },
      confidence: 0.0281,
      debug: {
        logits: [-0.38, 0.37],
        temperature: 1.9,
        bucket: "choice:2",
        answerConfidence: 0.5984,
        tokensRead: 44,
        stateKept: 18,
      },
    });
    expect(decision.usage).toEqual({ inputTokens: 44, outputTokens: 0 });
    expect(decision.timings).toMatchObject({
      load: 70.4,
      tokenize: 0.1,
      encode: 76.7,
    });
    expect(decision.debug).toMatchObject({ stateTokens: 18, truncated: false });
    expect(decision.costUsd).toBe(0);
  });

  test("lists the decision models nuclis prints, and only those", async () => {
    fake = fakeNuclis({ models: print(modelListing) });
    expect(await decider(fake).models()).toEqual([
      { id: "laya", label: "laya", available: true },
      { id: "laya-multilingual", label: "laya-multilingual", available: true },
      {
        id: "clef-flash",
        label: "clef-flash",
        available: false,
        reason: "not pulled: nuclis model pull clef-flash",
      },
    ]);
    expect(fake.args()).toBe("model ls --json");
  });

  test("reports its version, or why it cannot run", async () => {
    fake = fakeNuclis({});
    expect(await decider(fake).status()).toEqual({
      configured: true,
      reachable: true,
      version: "nuclis 0.4.0-test",
    });
    const missing = nuclisDecider(
      spawnTransport({ bin: `${fake.dir}/missing` }),
    );
    expect(await missing.status()).toMatchObject({ configured: false });
  });

  test("a failing decide is rejected with its last error line", async () => {
    fake = fakeNuclis({
      decide:
        "echo loading >&2; echo 'error: OptionsExceedBudget: question motion' >&2; exit 1",
    });
    await expect(
      decideWith(decider(fake), request, options()),
    ).rejects.toMatchObject({
      code: "rejected",
      message:
        "nuclis decide failed: error: OptionsExceedBudget: question motion",
    });
  });

  test("a missing binary is unconfigured", async () => {
    fake = fakeNuclis({});
    const missing = nuclisDecider(
      spawnTransport({ bin: `${fake.dir}/missing` }),
    );
    await expect(decideWith(missing, request, options())).rejects.toMatchObject(
      {
        code: "unconfigured",
      },
    );
  });

  test("malformed output and invalid answers are typed errors", async () => {
    fake = fakeNuclis({ decide: "echo 'not json'" });
    await expect(
      decideWith(decider(fake), request, options()),
    ).rejects.toMatchObject({
      code: "invalid_answer",
      message: "nuclis decide printed malformed JSON",
    });
    fake.remove();
    fake = fakeNuclis({ decide: print(decideOutput("swerve")) });
    await expect(
      decideWith(decider(fake), request, options()),
    ).rejects.toMatchObject({
      code: "invalid_answer",
    });
  });

  test("a slow decide times out and is killed", async () => {
    fake = fakeNuclis({ decide: "sleep 5" });
    const started = performance.now();
    await expect(
      decideWith(decider(fake), request, {
        model: "laya",
        signal: AbortSignal.timeout(200),
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

test("bulkLast moves bulky state fields last and keeps the rest in order", () => {
  const bulky = { samples: Array.from({ length: 80 }, (_, i) => [i, i]) };
  const bigger = { rows: Array.from({ length: 200 }, (_, i) => i) };
  const prepared = bulkLast({
    state: { style: "aggressive", bigger, road: bulky, signal: "red" },
    questions: request.questions,
  });
  expect(Object.keys(prepared.state as object)).toEqual([
    "style",
    "signal",
    "road",
    "bigger",
  ]);
  expect(bulkLast({ state: "text", questions: {} }).state).toBe("text");
});

describe("TypeSafe", () => {
  const stub = (
    respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  ) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  };

  test("sends Jev's request with the key and reads answers, usage, and cost", async () => {
    const { calls, fetch } = stub(() =>
      Response.json({
        model: "jev-1.13.0",
        answers: {
          motion: {
            choice: "stop",
            confidence: 0.8,
            probabilities: { drive: 0.2, stop: 0.8 },
          },
        },
        usage: { input_tokens: 2000, output_tokens: 80 },
      }),
    );
    const decider = typesafeDecider({ apiKey: "sk-test-123456", fetch });
    const decision = await decideWith(decider, request, options(JEV_MODEL));
    expect(calls[0]?.url).toBe(TYPESAFE_URL);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer sk-test-123456",
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: JEV_MODEL,
      ...request,
    });
    expect(decision.model).toBe("jev-1.13.0");
    expect(decision.answers.motion).toMatchObject({
      type: "choice",
      choice: "stop",
    });
    expect(decision.usage).toEqual({ inputTokens: 2000, outputTokens: 80 });
    expect(decision.costUsd).toBeCloseTo((2000 * 0.042) / 1e6, 12);
  });

  test("without a key it is unconfigured and makes no call", async () => {
    const { calls, fetch } = stub(() => Response.json({}));
    const decider = typesafeDecider({ apiKey: undefined, fetch });
    expect(await decider.status()).toMatchObject({ configured: false });
    await expect(
      decideWith(decider, request, options(JEV_MODEL)),
    ).rejects.toMatchObject({
      code: "unconfigured",
    });
    expect(calls).toHaveLength(0);
  });

  test("HTTP failures are typed and never echo the key", async () => {
    const cases: [number, string][] = [
      [401, "rejected"],
      [429, "rejected"],
      [400, "rejected"],
      [503, "unavailable"],
    ];
    for (const [status, code] of cases) {
      const { fetch } = stub(() => new Response("no", { status }));
      const error = await decideWith(
        typesafeDecider({ apiKey: "sk-secret-value", fetch }),
        request,
        options(JEV_MODEL),
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ code });
      expect(String((error as Error).message)).not.toContain("sk-secret-value");
    }
    const { fetch } = stub(() => {
      throw new TypeError("network down");
    });
    await expect(
      decideWith(
        typesafeDecider({ apiKey: "sk-secret-value", fetch }),
        request,
        options(JEV_MODEL),
      ),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "Could not reach TypeSafe",
    });
  });

  test("an answer naming an option not offered is invalid", async () => {
    const { fetch } = stub(() =>
      Response.json({ answers: { motion: { choice: "swerve" } }, usage: {} }),
    );
    await expect(
      decideWith(
        typesafeDecider({ apiKey: "sk-test-123456", fetch }),
        request,
        options(JEV_MODEL),
      ),
    ).rejects.toMatchObject({ code: "invalid_answer" });
  });
});

describe("random", () => {
  const all: Request = {
    state: { n: 1 },
    questions: {
      pick: {
        type: "choice",
        instructions: "?",
        criteria: { a: null, b: null, c: null },
      },
      level: { type: "score", instructions: "?", criteria: ["x", "y"] },
      yes: { type: "noul", instructions: "?" },
    },
  };

  test("answers every question validly, the same way for the same seed and request", async () => {
    const decider = randomDecider();
    const run = (seed: number, req = all) =>
      decideWith(decider, req, { ...options("uniform"), seed });
    const first = await run(7);
    expect((await run(7)).answers).toEqual(first.answers);
    expect(first.answers.pick).toMatchObject({
      probabilities: { a: 1 / 3, b: 1 / 3, c: 1 / 3 },
      confidence: 0,
    });
    const picks = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      const answer = (await run(seed)).answers.pick;
      if (answer?.type === "choice") picks.add(answer.choice);
    }
    expect([...picks].sort()).toEqual(["a", "b", "c"]);
  });
});
