import { describe, expect, test } from "bun:test";
import type { Decider } from "../src/contract/decider.ts";
import { decideWith } from "../src/contract/decider.ts";
import { randomDecider } from "../src/deciders/random.ts";
import {
  CASES_PER_RUN,
  type CrossingRun,
  crossing,
  expectedMotion,
} from "../src/dungeons/crossing/crossing.ts";
import { playTurn } from "../src/dungeons/turn.ts";

async function play(
  decider: Decider,
  model: string,
  seed: number,
  level: string,
) {
  const run = crossing.create(seed, level);
  while (!crossing.outcome(run).finished)
    await playTurn(crossing, run, (request) =>
      decideWith(decider, request, {
        model,
        seed,
        signal: AbortSignal.timeout(1000),
      }),
    );
  return { run, outcome: crossing.outcome(run) };
}

describe("crossing", () => {
  test("the same seed and level give the same cases", () => {
    const a = crossing.create(5, "mixed");
    const b = crossing.create(5, "mixed");
    expect(a.cases).toEqual(b.cases);
    expect(a.cases).toHaveLength(CASES_PER_RUN);
    expect(crossing.create(6, "mixed").cases).not.toEqual(a.cases);
    expect(() => crossing.create(1, "nowhere")).toThrow("no level");
  });

  test("levels draw the cases they promise", () => {
    for (let seed = 1; seed <= 20; seed++) {
      for (const c of crossing.create(seed, "signal").cases)
        expect(c.bumperToLine).toBeLessThanOrEqual(1);
      for (const c of crossing.create(seed, "distance").cases)
        expect(c.signal).toBe("red");
    }
  });

  test("the threshold is inclusive and green always drives", () => {
    expect(expectedMotion("red", 1)).toBe("stop");
    expect(expectedMotion("red", 1.1)).toBe("drive");
    expect(expectedMotion("amber", 0.3)).toBe("stop");
    expect(expectedMotion("green", 0.3)).toBe("drive");
  });

  test("the rule passes every level", async () => {
    for (const level of crossing.levels) {
      const { outcome } = await play(crossing.rule, "baseline", 11, level.id);
      expect(outcome).toMatchObject({
        finished: true,
        passed: true,
        violations: 0,
      });
      expect(outcome.metrics).toMatchObject({
        correct: CASES_PER_RUN,
        accuracy: 1,
      });
    }
  });

  test("random is scored, and repeats exactly for a seed", async () => {
    const first = await play(randomDecider(), "uniform", 4, "distance");
    const again = await play(randomDecider(), "uniform", 4, "distance");
    expect(again.outcome).toEqual(first.outcome);
    expect(first.outcome.metrics.decided).toBe(CASES_PER_RUN);
    const ran = first.outcome.records.filter((r) => r.violation);
    expect(first.outcome.violations).toBe(ran.length);
    for (const r of ran) expect(r.violation).toBe("ran the red light");
  });

  test("an unfinished run has no pass verdict and no accuracy", () => {
    const run: CrossingRun = crossing.create(1, "mixed");
    expect(crossing.outcome(run)).toEqual({
      finished: false,
      violations: 0,
      metrics: { cases: CASES_PER_RUN, decided: 0, correct: 0 },
      records: [],
    });
  });

  test("the rule refuses a state it cannot read", async () => {
    await expect(
      decideWith(
        crossing.rule,
        {
          state: "no intersection",
          questions: {
            motion: {
              type: "choice",
              instructions: "",
              criteria: { drive: null },
            },
          },
        },
        { model: "baseline", signal: AbortSignal.timeout(1000) },
      ),
    ).rejects.toMatchObject({ code: "rejected" });
  });
});
