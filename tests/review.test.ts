import { describe, expect, test } from "bun:test";
import { validateAnswers } from "../src/contract/validate.ts";
import {
  REVIEW_GENERATOR,
  reviewCases,
} from "../src/dungeons/review/generate.ts";
import { review } from "../src/dungeons/review/review.ts";
import type { CaseSet } from "../src/dungeons/text/cases.ts";

describe("review generator", () => {
  const levels = [
    "gate",
    "locate",
    "kind",
    "returns",
    "ci",
    "long",
    "all-questions",
  ];

  test("generates cases for all levels with valid fields", () => {
    for (const lvl of levels) {
      const cases = reviewCases(lvl, 5, 42);
      expect(cases.length).toBe(5);
      for (const c of cases) {
        expect(c.level).toBe(lvl);
        expect(c.id).toContain(lvl);
        expect(c.why.length).toBeGreaterThan(0);
        expect(c.input).toBeDefined();
        expect(Object.keys(c.truth).length).toBeGreaterThan(0);
      }
    }
  });

  test("cases are deterministic for the same seed", () => {
    const a = reviewCases("gate", 3, 101);
    const b = reviewCases("gate", 3, 101);
    expect(a).toEqual(b);
  });
});

describe("review dungeon rule and run loop", () => {
  test("rule answers all levels with valid typed answers", async () => {
    const levels = [
      "gate",
      "locate",
      "kind",
      "returns",
      "ci",
      "long",
      "all-questions",
    ];
    for (const lvl of levels) {
      const cases = reviewCases(lvl, 4, 123);
      const caseSet: CaseSet = {
        dungeon: "review",
        name: "test-set",
        generator: REVIEW_GENERATOR,
        seed: 123,
        count: cases.length,
        hash: "dummyhash",
        levels: { [lvl]: cases.length },
        cases,
      };

      const run = review.create(123, lvl, { cases: caseSet });
      while (run.index < run.cases.length) {
        const obs = review.observe(run);
        expect(obs.request).toBeDefined();

        const res = await review.rule.decide(obs.request, {
          model: "baseline",
          signal: new AbortController().signal,
        });
        const validated = validateAnswers(obs.request, res.answers);
        expect(validated).toEqual(res.answers);
        review.apply(run, res.answers);
      }
      const outcome = review.outcome(run);
      expect(outcome.finished).toBe(true);
      expect(outcome.records.length).toBe(cases.length);
    }
  });
});
