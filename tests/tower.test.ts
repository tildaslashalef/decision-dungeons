import { describe, expect, test } from "bun:test";
import { decideWith } from "../src/contract/decider.ts";
import type { Request } from "../src/contract/request.ts";
import { parseRequest } from "../src/contract/validate.ts";
import { randomDecider } from "../src/deciders/random.ts";
import type { AnyDungeon } from "../src/dungeons/dungeon.ts";
import { runEpisode } from "../src/dungeons/run.ts";
import { DT } from "../src/dungeons/tower/sim.ts";
import { type TowerRun, tower } from "../src/dungeons/tower/tower.ts";
import { playTurn } from "../src/dungeons/turn.ts";

const options = (model: string, seed = 1) => ({
  model,
  seed,
  signal: AbortSignal.timeout(2000),
});
const byRule = (r: Request) => decideWith(tower.rule, r, options("baseline"));
const byRandom = (seed: number) => (r: Request) =>
  decideWith(randomDecider(), r, options("uniform", seed));

describe("night tower", () => {
  test("the rule works every level without an incident", async () => {
    for (const level of tower.levels)
      for (const seed of [1, 2]) {
        const result = await runEpisode(
          tower as AnyDungeon,
          level.id,
          seed,
          { id: "rule", model: "baseline" },
          byRule,
        );
        expect(result.outcome.passed).toBe(true);
        expect(result.outcome.violations).toBe(0);
      }
  });

  test("random fails the traffic levels with incidents", async () => {
    for (const level of ["evening", "rush", "low-vis"]) {
      const result = await runEpisode(
        tower as AnyDungeon,
        level,
        1,
        { id: "random", model: "uniform" },
        byRandom(1),
      );
      expect(result.outcome.passed).toBe(false);
      expect(result.outcome.violations).toBeGreaterThan(0);
    }
  });

  test("every request is a valid contract request whose options carry the numbers", async () => {
    const run = tower.create(3, "rush") as TowerRun;
    let asked = 0;
    for (let i = 0; i < 60 && !tower.outcome(run).finished; i++) {
      const { request } = tower.observe(run);
      // A turn with no question is never sent; one with questions must be valid.
      if (Object.keys(request.questions).length)
        expect(() => parseRequest(request)).not.toThrow();
      const land = request.questions.land;
      if (land?.type === "choice") {
        asked++;
        expect(land.criteria.land).toMatch(/threshold in \d+ s/);
      }
      await playTurn(tower as AnyDungeon, run, byRule);
    }
    expect(asked).toBeGreaterThan(3);
  });

  test("the go-around check passes only when the arrival is sent around", async () => {
    const send = await runEpisode(
      tower as AnyDungeon,
      "go-around",
      4,
      { id: "rule", model: "baseline" },
      byRule,
    );
    expect(send.outcome.passed).toBe(true);
    expect(send.outcome.metrics.go_arounds).toBe(1);
    // Clearing it to land over the stopped jet is an incursion.
    const land = await runEpisode(
      tower as AnyDungeon,
      "go-around",
      4,
      { id: "fixed", model: "land" },
      async (request) => ({
        decider: "fixed",
        model: "land",
        answers: Object.fromEntries(
          Object.keys(request.questions).map((q) => [
            q,
            { type: "choice", choice: q === "land" ? "land" : "hold" },
          ]),
        ),
        timings: { total: 0 },
      }),
    );
    expect(land.outcome.passed).toBe(false);
    expect(land.outcome.violations).toBe(1);
  });

  test("stepping frame by frame plays the headless run exactly", async () => {
    const headless = tower.create(5, "evening") as TowerRun;
    let outcome = tower.outcome(headless);
    while (!outcome.finished)
      outcome = (await playTurn(tower as AnyDungeon, headless, byRandom(5)))
        .outcome;
    // The stage: step 50 ms at a time, and at a question observe, decide, apply.
    const staged = tower.create(5, "evening") as TowerRun;
    const decide = byRandom(5);
    while (!tower.outcome(staged).finished) {
      const t = staged.tower;
      if (t.pendingLand || t.pendingDepart) {
        const { request } = tower.observe(staged);
        tower.apply(staged, (await decide(request)).answers);
      } else tower.step(staged, DT);
    }
    expect(tower.outcome(staged)).toEqual(tower.outcome(headless));
    expect(staged.tower.events).toEqual(headless.tower.events);
  }, 30_000);
});
