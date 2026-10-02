import { describe, expect, test } from "bun:test";
import { decideManyWith, decideWith } from "../src/contract/decider.ts";
import type { Request } from "../src/contract/request.ts";
import {
  bulkLast,
  nuclisDecider,
  sequenceTokens,
} from "../src/deciders/nuclis.ts";
import { apiBase, nuclisHttp } from "../src/deciders/nuclis-http.ts";
import { randomDecider } from "../src/deciders/random.ts";
import {
  JEV_MODEL,
  TYPESAFE_URL,
  typesafeDecider,
} from "../src/deciders/typesafe.ts";
import {
  decideOutput,
  FAKE_NUCLIS_URL,
  type FakeNuclis,
  type FakeRoutes,
  fakeNuclis,
  modelEntry,
  modelListing,
  ok,
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
/** The decision calls a fake received, without the model listing reads. */
const posts = (fake: FakeNuclis) =>
  fake.calls.filter((c) => c.method === "POST");
const options = (model = "laya") => ({
  model,
  signal: AbortSignal.timeout(5000),
});

describe("nuclis over its API", () => {
  const setup = (routes: FakeRoutes) => {
    const fake = fakeNuclis(routes);
    const decider = nuclisDecider(
      nuclisHttp({ url: FAKE_NUCLIS_URL, fetch: fake.fetch }),
    );
    return { fake, decider };
  };

  test("posts the request and reads the answers, timings, and debug fields", async () => {
    const { fake, decider } = setup({
      decisions: () => ok(decideOutput("stop")),
    });
    const decision = await decideWith(decider, request, options());
    expect(posts(fake)).toEqual([
      {
        method: "POST",
        path: "/decisions?explain=1",
        body: { model: "laya", ...request },
      },
    ]);
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

  test("an empty bucket is not reported, so no field looks measured", async () => {
    const output = decideOutput("stop");
    const motion = output.results[0]?.answers.motion;
    if (motion) {
      motion.nuclis.bucket = "";
      const { sequence_tokens: _t, state_kept: _k, ...rest } = motion.nuclis;
      motion.nuclis = rest as typeof motion.nuclis;
    }
    const { decider } = setup({ decisions: () => ok(output) });
    const decision = await decideWith(decider, request, options("clef-flash"));
    expect(decision.answers.motion?.debug).toEqual({
      logits: [-0.38, 0.37],
      temperature: 1.9,
      answerConfidence: 0.5984,
    });
  });

  test("lists the decision models nuclis serves, and only those", async () => {
    const listing = {
      ...modelListing,
      data: [
        ...modelListing.data,
        modelEntry("mystery", "decision", true, null),
      ],
    };
    const { decider } = setup({ models: () => ok(listing) });
    expect(await decider.models()).toEqual([
      { id: "laya", label: "laya", available: true, packs: true },
      {
        id: "laya-multilingual",
        label: "laya-multilingual",
        available: true,
        packs: true,
      },
      {
        id: "clef-flash",
        label: "clef-flash",
        available: true,
        images: true,
        packs: false,
      },
      {
        id: "laya-next",
        label: "laya-next",
        available: false,
        reason: "not pulled: nuclis model pull laya-next",
        packs: true,
      },
      {
        id: "mystery",
        label: "mystery",
        available: false,
        reason: "nuclis does not say how it runs (nuclis.packs)",
      },
    ]);
    await expect(
      decideWith(decider, request, options("mystery")),
    ).rejects.toMatchObject({ code: "rejected" });
    expect(posts(setup({}).fake)).toHaveLength(0);
  });

  test("a model that does not pack gets one state per request, two in flight", async () => {
    let inFlight = 0;
    let most = 0;
    const { fake, decider } = setup({
      decisions: () => {
        most = Math.max(most, ++inFlight);
        return ok(decideOutput("stop"));
      },
    });
    // The fake answers at once; hold each answer a tick so calls overlap.
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fake.fetch(input, init);
      await Bun.sleep(5);
      if (init?.method === "POST") inFlight--;
      return res;
    }) as typeof fetch;
    const clef = nuclisDecider(
      nuclisHttp({ url: FAKE_NUCLIS_URL, fetch: slow }),
    );
    expect(await clef.batches?.("clef-flash")).toBe(false);
    expect(await decider.batches?.("laya")).toBe(true);
    const many = Array.from({ length: 5 }, (_, n) => ({
      ...request,
      state: { n },
    }));
    const batched = await decideManyWith(clef, many, options("clef-flash"));
    expect(batched).toHaveLength(5);
    const alone = await Promise.all(
      many.map((r) => decideWith(clef, r, options("clef-flash"))),
    );
    expect(alone).toHaveLength(5);
    const bodies = posts(fake).map((c) => c.body as Record<string, unknown>);
    expect(bodies).toHaveLength(10);
    expect(bodies.every((b) => "state" in b && !("states" in b))).toBe(true);
    expect(most).toBe(2);
  });

  test("sends a request's images, and batches only requests with the same ones", async () => {
    const png = (n: number) => `data:image/png;base64,${"A".repeat(n)}=`;
    const { fake, decider } = setup({
      decisions: (body) => {
        const states = (body as { states?: unknown[] }).states ?? [0];
        const one = decideOutput("stop").results[0];
        return ok({ ...decideOutput("stop"), results: states.map(() => one) });
      },
    });
    const seen = { ...request, images: [png(4)] };
    await decideWith(decider, seen, options("clef-flash"));
    expect(posts(fake)[0]?.body).toMatchObject({ images: [png(4)] });
    const requests = [seen, seen, { ...request, images: [png(8)] }, request];
    await decideManyWith(decider, requests, options("laya"));
    const calls = posts(fake)
      .slice(1)
      .map((c) => c.body as { states: unknown[]; images?: string[] });
    expect(calls.map((c) => [c.states.length, c.images?.[0]])).toEqual([
      [2, png(4)],
      [1, png(8)],
      [1, undefined],
    ]);
  });

  test("bounds a packing model per call and any other by its tokens", async () => {
    const { decider } = setup({});
    const seventy = Array.from({ length: 70 }, () => request);
    expect(await decider.timeoutMs?.([request], "laya")).toBe(20_000);
    expect(await decider.timeoutMs?.(seventy, "laya")).toBe(40_000);
    const tokens = sequenceTokens(request);
    expect(tokens).toBeGreaterThan(150);
    expect(await decider.timeoutMs?.([request, request], "clef-flash")).toBe(
      300_000 + 2 * tokens * 8,
    );
    const huge = { ...request, state: "x".repeat(200_000) };
    expect(sequenceTokens(huge, 16_384)).toBe(16_384);
    // Unreachable: the short bound, since the call fails fast.
    const down = setup({ models: () => ({ throws: new Error("down") }) });
    expect(await down.decider.timeoutMs?.([request], "clef-flash")).toBe(
      20_000,
    );
  });

  test("reports its version from /health, or why it cannot be reached", async () => {
    expect(await setup({}).decider.status()).toEqual({
      configured: true,
      reachable: true,
      version: "nuclis 0.4.0-test",
    });
    const refused = Object.assign(new Error("Unable to connect"), {
      code: "ConnectionRefused",
    });
    const down = setup({ health: () => ({ throws: refused }) }).decider;
    expect(await down.status()).toEqual({
      configured: true,
      reachable: false,
      reason: `nuclis serve is not running at ${FAKE_NUCLIS_URL}; start it with nuclis serve`,
    });
  });

  test("a bare origin gets /v1, and a URL that is not the API says so", async () => {
    expect(apiBase("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000/v1");
    expect(apiBase("http://127.0.0.1:8000/")).toBe("http://127.0.0.1:8000/v1");
    expect(apiBase("http://127.0.0.1:8000/v1/")).toBe(
      "http://127.0.0.1:8000/v1",
    );
    const elsewhere = nuclisDecider(
      nuclisHttp({
        url: "http://127.0.0.1:8000/api",
        fetch: (async () =>
          new Response("<h1>Not Found</h1>", {
            status: 404,
          })) as unknown as typeof fetch,
      }),
    );
    expect(await elsewhere.status()).toMatchObject({
      reachable: false,
      reason:
        "no nuclis API at http://127.0.0.1:8000/api (HTTP 404); its routes are under /v1",
    });
  });

  test("a 422 is rejected with nuclis's code and message", async () => {
    const { decider } = setup({
      decisions: () => ({
        status: 422,
        body: {
          error: {
            code: "options_exceed_budget",
            message: "question motion: options do not fit",
          },
        },
      }),
    });
    await expect(decideWith(decider, request, options())).rejects.toMatchObject(
      {
        code: "rejected",
        message:
          "nuclis /decisions?explain=1: options_exceed_budget: question motion: options do not fit",
      },
    );
  });

  test("529 is retried with backoff, then answered", async () => {
    let busy = 2;
    const { fake, decider } = setup({
      decisions: () =>
        busy-- > 0
          ? {
              status: 529,
              body: { error: { code: "busy", message: "64 waiting" } },
            }
          : ok(decideOutput("drive")),
    });
    const decision = await decideWith(decider, request, options());
    expect(decision.answers.motion).toMatchObject({ choice: "drive" });
    expect(posts(fake)).toHaveLength(3);
  });

  test("a server that stays busy is unavailable", async () => {
    const { fake, decider } = setup({
      decisions: () => ({
        status: 529,
        body: { error: { code: "busy", message: "64 waiting" } },
      }),
    });
    await expect(decideWith(decider, request, options())).rejects.toMatchObject(
      {
        code: "unavailable",
        message: "nuclis /decisions?explain=1: busy: 64 waiting",
      },
    );
    expect(posts(fake)).toHaveLength(5);
  });

  test("malformed output and invalid answers are typed errors", async () => {
    const malformed = setup({
      decisions: () => ({ status: 200, body: "not an object" }),
    });
    await expect(
      decideWith(malformed.decider, request, options()),
    ).rejects.toMatchObject({ code: "invalid_answer" });
    const swerve = setup({ decisions: () => ok(decideOutput("swerve")) });
    await expect(
      decideWith(swerve.decider, request, options()),
    ).rejects.toMatchObject({ code: "invalid_answer" });
  });

  test("batches many states per call, grouped by questions, in order", async () => {
    const { fake, decider } = setup({
      decisions: (body) => {
        const states = (body as { states: { n: number }[] }).states;
        const one = decideOutput("stop").results[0];
        return ok({ ...decideOutput("stop"), results: states.map(() => one) });
      },
    });
    const many = Array.from({ length: 70 }, (_, n) => ({
      ...request,
      state: { n },
    }));
    const other = {
      ...request,
      questions: {
        motion: { ...request.questions.motion, instructions: "Other?" },
      },
    };
    const decisions = await decideManyWith(
      decider,
      [...many, other as Request],
      options(),
    );
    expect(decisions).toHaveLength(71);
    // 70 with one question set: 64 then 6; the odd one alone.
    expect(
      posts(fake).map((c) => (c.body as { states: unknown[] }).states.length),
    ).toEqual([64, 6, 1]);
    expect(decisions[0]?.debug?.batch).toBe(64);
    expect(decisions[70]?.debug?.batch).toBe(1);
    expect(decisions.every((d) => d.answers.motion?.type === "choice")).toBe(
      true,
    );
  });

  test("a batch answered with the wrong count is a typed error", async () => {
    const { decider } = setup({ decisions: () => ok(decideOutput("stop")) });
    await expect(
      decideManyWith(decider, [request, request], options()),
    ).rejects.toMatchObject({ code: "invalid_answer" });
  });

  test("a slow answer times out", async () => {
    const decider = nuclisDecider(
      nuclisHttp({
        url: FAKE_NUCLIS_URL,
        fetch: ((_: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            ),
          )) as typeof fetch,
      }),
    );
    const started = performance.now();
    await expect(
      decideWith(decider, request, {
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

  test("refuses a request with images, sending nothing", async () => {
    const calls: unknown[] = [];
    const decider = typesafeDecider({
      apiKey: "sk-test",
      fetch: (async (...args: unknown[]) => {
        calls.push(args);
        return Response.json({});
      }) as typeof fetch,
    });
    await expect(
      decideWith(
        decider,
        { ...request, images: ["data:image/png;base64,AA=="] },
        options(JEV_MODEL),
      ),
    ).rejects.toMatchObject({ code: "rejected" });
    expect(calls).toHaveLength(0);
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
