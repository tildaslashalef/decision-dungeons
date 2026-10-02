import { describe, expect, test } from "bun:test";
import { type Decider, decideWith } from "../src/contract/decider.ts";
import { DecideError } from "../src/contract/errors.ts";
import type { Request } from "../src/contract/request.ts";
import {
  MAX_IMAGE_CHARS,
  parseRequest,
  RequestError,
  validateAnswers,
} from "../src/contract/validate.ts";

const request: Request = {
  state: { signal: "red" },
  questions: {
    motion: {
      type: "choice",
      instructions: "Drive or stop?",
      criteria: { drive: null, stop: "brake now" },
    },
    urgency: {
      type: "score",
      instructions: "How urgent?",
      criteria: ["low", "mid", "high"],
    },
    risky: { type: "noul", instructions: "Is it risky?" },
  },
};

const good = {
  motion: {
    type: "choice",
    choice: "stop",
    probabilities: { drive: 0.4, stop: 0.6 },
    confidence: 0.03,
  },
  urgency: {
    type: "score",
    score: 1.48,
    probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 },
  },
  risky: { type: "noul", noul: 0.93 },
};

function invalid(raw: unknown): string {
  try {
    validateAnswers(request, raw);
  } catch (error) {
    expect(error).toBeInstanceOf(DecideError);
    expect((error as DecideError).code).toBe("invalid_answer");
    return (error as DecideError).message;
  }
  throw new Error("expected invalid_answer");
}

describe("validateAnswers", () => {
  test("accepts Jev's answers, keeping only known fields", () => {
    const answers = validateAnswers(request, {
      ...good,
      motion: { ...good.motion, extra: "dropped" },
    });
    expect(answers.motion).toEqual({
      type: "choice",
      choice: "stop",
      probabilities: { drive: 0.4, stop: 0.6 },
      confidence: 0.03,
    });
    expect(answers.urgency?.type).toBe("score");
    expect(answers.risky).toEqual({ type: "noul", noul: 0.93 });
  });

  test("takes an answer without a type, as Jev sends", () => {
    const { type: _, ...untyped } = good.motion;
    expect(
      validateAnswers(request, { ...good, motion: untyped }).motion?.type,
    ).toBe("choice");
  });

  test("refuses an option that was not offered", () => {
    expect(invalid({ ...good, motion: { choice: "swerve" } })).toContain(
      "not an offered option",
    );
    expect(
      invalid({
        ...good,
        motion: { choice: "stop", probabilities: { stop: 0.5, swerve: 0.5 } },
      }),
    ).toContain("swerve");
  });

  test("refuses probabilities that are not finite or do not sum to 1", () => {
    expect(
      invalid({
        ...good,
        motion: { choice: "stop", probabilities: { stop: Number.NaN } },
      }),
    ).toContain("not in [0, 1]");
    expect(
      invalid({
        ...good,
        motion: { choice: "stop", probabilities: { drive: 0.2, stop: 0.2 } },
      }),
    ).toContain("below 1");
    expect(
      invalid({ ...good, risky: { noul: Number.POSITIVE_INFINITY } }),
    ).toContain("noul");
    expect(invalid({ ...good, urgency: { score: 3 } })).toContain("[0, 2]");
  });

  test("refuses a missing answer, an extra one, and a mismatched type", () => {
    const { risky: _, ...missing } = good;
    expect(invalid(missing)).toBe("answer risky: missing");
    expect(invalid({ ...good, other: { noul: 1 } })).toContain("not asked");
    expect(
      invalid({ ...good, risky: { type: "choice", choice: "x" } }),
    ).toContain("type choice");
    expect(invalid(null)).toContain("must be an object");
  });

  test("checks debug fields instead of passing them through", () => {
    const answers = validateAnswers(request, {
      ...good,
      risky: { noul: 0.5, debug: { logits: [1, 2], bucket: "noul:2" } },
    });
    expect(answers.risky?.debug).toEqual({ logits: [1, 2], bucket: "noul:2" });
    expect(
      invalid({
        ...good,
        risky: { noul: 0.5, debug: { logits: [Number.NaN] } },
      }),
    ).toContain("logits");
  });
});

describe("parseRequest", () => {
  test("accepts the three question types", () => {
    expect(parseRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });

  test("names the question that is wrong", () => {
    const bad = (questions: unknown) => () =>
      parseRequest({ state: "s", questions });
    expect(bad({ q: { type: "choice", instructions: "i" } })).toThrow(
      "question q: criteria",
    );
    expect(bad({ q: { type: "rank", instructions: "i" } })).toThrow(
      RequestError,
    );
    expect(bad({})).toThrow("1 to 32 questions");
    expect(() => parseRequest({ questions: {} })).toThrow("needs a state");
    expect(
      bad({ q: { type: "noul", instructions: "i", criteria: { maybe: "x" } } }),
    ).toThrow("only the keys true and false");
  });

  test("takes images as base64 data URLs only, within nuclis's bounds", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const withImages = (images: unknown) => () =>
      parseRequest({ ...request, images });
    expect(withImages([png])()).toEqual({ ...request, images: [png] });
    expect(withImages([])).toThrow("1 to 8");
    expect(withImages(Array(9).fill(png))).toThrow("1 to 8");
    expect(withImages(["https://example.com/a.png"])).toThrow("data URL");
    expect(withImages(["data:image/svg+xml;base64,PHN2Zz4="])).toThrow(
      "data URL",
    );
    expect(withImages(["data:image/png;base64,not base64!"])).toThrow(
      "data URL",
    );
    const huge = `data:image/png;base64,${"A".repeat(MAX_IMAGE_CHARS)}`;
    expect(withImages([huge])).toThrow("characters in all");
  });
});

describe("decideWith", () => {
  const fixed = (answers: unknown, prepare?: Decider["prepare"]): Decider => ({
    id: "fixed",
    label: "Fixed",
    models: async () => [],
    status: async () => ({ configured: true }),
    ...(prepare ? { prepare } : {}),
    decide: async () => ({
      decider: "fixed",
      model: "m",
      // Deliberately unchecked: decideWith must validate what deciders return.
      answers: answers as never,
      timings: { total: 0 },
    }),
  });
  const options = () => ({ model: "m", signal: AbortSignal.timeout(1000) });

  test("validates answers against the request the decider received", async () => {
    const one: Request = {
      state: {},
      questions: { risky: { type: "noul", instructions: "?" } },
    };
    const decision = await decideWith(
      fixed({ risky: { noul: 0.2 } }),
      one,
      options(),
    );
    expect(decision.answers.risky).toEqual({ type: "noul", noul: 0.2 });
    expect(decision.debug?.request).toEqual(one);
    expect(decision.timings.total).toBeGreaterThanOrEqual(0);
    await expect(
      decideWith(fixed({ risky: { noul: 2 } }), one, options()),
    ).rejects.toMatchObject({ code: "invalid_answer" });
  });

  test("records the prepared request and turns stray errors into typed ones", async () => {
    const one: Request = {
      state: { a: 1 },
      questions: { risky: { type: "noul", instructions: "?" } },
    };
    const decision = await decideWith(
      fixed({ risky: { noul: 0.2 } }, (r) => ({ ...r, state: "prepared" })),
      one,
      options(),
    );
    expect(decision.debug?.request?.state).toBe("prepared");
    const throwing: Decider = {
      ...fixed({}),
      decide: async () => {
        throw new TypeError("boom");
      },
    };
    await expect(decideWith(throwing, one, options())).rejects.toMatchObject({
      code: "unavailable",
      message: "Fixed failed: boom",
    });
  });
});
