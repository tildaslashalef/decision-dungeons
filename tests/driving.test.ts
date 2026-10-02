import { describe, expect, test } from "bun:test";
import { decideWith } from "../src/contract/decider.ts";
import type { Request } from "../src/contract/request.ts";
import { parseRequest, validateAnswers } from "../src/contract/validate.ts";
import { bulkLast } from "../src/deciders/nuclis.ts";
import { randomDecider } from "../src/deciders/random.ts";
import { crossing } from "../src/dungeons/crossing/crossing.ts";
import {
  decideByRule,
  drivingRule,
} from "../src/dungeons/driving/decide/rule.ts";
import { driving } from "../src/dungeons/driving/driving.ts";
import { SCENARIOS } from "../src/dungeons/driving/scenarios.ts";
import { worldObservation } from "../src/dungeons/driving/sim/observation.ts";
import { generateWorld } from "../src/dungeons/driving/world/world.ts";
import { runEpisode } from "../src/dungeons/run.ts";
import { playTurn } from "../src/dungeons/turn.ts";

const ids = { id: "random", model: "uniform" };

const options = (model: string, seed = 1) => ({
  model,
  seed,
  signal: AbortSignal.timeout(10_000),
});

describe("worlds", () => {
  test("a seed always builds the same world", () => {
    for (const type of ["town", "city", "highway"] as const) {
      const a = generateWorld(7, type);
      const b = generateWorld(7, type);
      expect(a.route.points).toEqual(b.route.points);
      expect(a.objects).toEqual(b.objects);
      expect(a.route.length).toBeGreaterThan(100);
    }
    expect(generateWorld(8, "town").route.points).not.toEqual(
      generateWorld(7, "town").route.points,
    );
  });

  test("grid routes stop at their junctions; the highway trip passes every section", () => {
    const town = generateWorld(1, "town");
    expect(town.route.crossings.length).toBeGreaterThan(0);
    for (const c of town.route.crossings) expect(c.stopS).toBeGreaterThan(0);
    const highway = generateWorld(1, "highway");
    expect(highway.route.sections?.map((s) => s.kind)).toEqual([
      "local",
      "ramp_turn",
      "onramp",
      "merge",
      "interstate",
      "exit",
      "offramp",
      "town",
    ]);
  });
});

describe("the decision request", () => {
  test("is a valid contract request with described options and Jev's tables", () => {
    const run = driving.create(1, "town");
    const { request, resolved } = driving.observe(run);
    // Crosses the server's boundary unchanged (JSON has no −0).
    const wire = JSON.parse(JSON.stringify(request));
    expect(parseRequest(wire)).toEqual(wire);
    const vector = request.questions.vector;
    expect(vector?.type).toBe("choice");
    if (vector?.type !== "choice") return;
    for (const description of Object.values(vector.criteria))
      expect(description).toMatch(/speed .*progress/);
    expect(vector.instructions.endsWith("preview end is not road end.")).toBe(
      true,
    );
    const state = request.state as Record<string, unknown>;
    expect(state.candidates).toBeDefined();
    expect(Object.keys(state).slice(0, 3)).toEqual([
      "driving_style",
      "units",
      "speed",
    ]);
    // At the start the only motion is drive: answered here, not asked.
    expect(resolved?.motion).toMatchObject({ type: "choice", choice: "drive" });
  });

  test("bulky fields move last for nuclis, and the options still carry the facts", () => {
    const { request } = driving.observe(driving.create(2, "city"));
    const prepared = bulkLast(request);
    const keys = Object.keys(prepared.state as object);
    expect(keys.indexOf("candidates")).toBeGreaterThan(keys.indexOf("nav"));
    expect(prepared.questions).toEqual(request.questions);
  });
});

describe("the rule", () => {
  test("answers every question it is asked, with a valid distribution", async () => {
    const run = driving.create(3, "town");
    for (let i = 0; i < 8; i++) {
      const turn = await playTurn(driving, run, (r: Request) =>
        decideWith(drivingRule, r, options("baseline")),
      );
      expect(Object.keys(turn.answers)).toContain("vector");
    }
    const { request } = driving.observe(run);
    expect(() => validateAnswers(request, decideByRule(request))).not.toThrow();
  });

  test("passes the stop-line check: stops short of a red line, goes on green", async () => {
    const run = driving.create(42, "stop-line");
    let outcome = driving.outcome(run);
    while (!outcome.finished)
      outcome = (
        await playTurn(driving, run, (r: Request) =>
          decideWith(drivingRule, r, options("baseline")),
        )
      ).outcome;
    expect(outcome.passed).toBe(true);
    const center = outcome.metrics.stopped_center_m as number;
    expect(center).toBeLessThan(3.5);
    expect(center).toBeGreaterThan(run.sim.player.depth / 2);
    expect(outcome.violations).toBe(0);
  }, 30_000);
});

test("the same seed and answers replay the same run, inspected or not", async () => {
  const play = async (inspect: boolean) => {
    const run = driving.create(5, "highway");
    for (let i = 0; i < 12; i++) {
      if (inspect) JSON.stringify(worldObservation(run.sim));
      await playTurn(driving, run, (r: Request) =>
        decideWith(randomDecider(), r, options("uniform", 5)),
      );
    }
    return {
      x: run.sim.player.x,
      z: run.sim.player.z,
      speed: run.sim.player.speed,
      t: run.sim.time,
    };
  };
  const plain = await play(false);
  expect(await play(false)).toEqual(plain);
  expect(await play(true)).toEqual(plain);
}, 30_000);

describe("evaluation mode", () => {
  test("turns off the safety brake and the collision filter, and only when asked", () => {
    const plain = driving.create(1, "town");
    expect(plain.sim.safety).toBe(true);
    expect(driving.observe(plain).request).toBeDefined();
    expect(plain.pending?.state.evaluation).toBeUndefined();
    const evaluated = driving.create(1, "town", { evaluation: true });
    expect(evaluated.sim.safety).toBe(false);
    driving.observe(evaluated);
    expect(evaluated.pending?.state.evaluation).toBe(true);
  });

  test("offers in-lane paths predicted to collide that the default run never does", async () => {
    // Town seed 1 under the rule: the default planner tapers every path to
    // the traffic ahead; evaluation mode offers faster ones that would hit.
    const offered = async (evaluation: boolean) => {
      const run = driving.create(1, "town", { evaluation });
      let count = 0;
      for (let i = 0; i < 100; i++) {
        const turn = await playTurn(driving, run, (r: Request) =>
          decideWith(drivingRule, r, options("baseline")),
        );
        const vectors = run.sim.lastDecisionState?.vectors ?? {};
        for (const id of Object.keys(run.sim.lastPlan?.eligible ?? {})) {
          const v = vectors[id];
          if (v?.collision_imminent && v.velocity_mps !== 0 && v.stays_on_road)
            count++;
        }
        if (turn.outcome.finished) break;
      }
      return count;
    };
    expect(await offered(false)).toBe(0);
    expect(await offered(true)).toBeGreaterThan(0);
  }, 60_000);

  test("is recorded in every result, and ignored by a dungeon without safety nets", async () => {
    const decide = (r: Request) =>
      decideWith(randomDecider(), r, options("uniform", 1));
    const plain = await runEpisode(crossing, "signal", 1, ids, decide);
    expect(plain.evaluation).toBe(false);
    const asked = await runEpisode(crossing, "signal", 1, ids, decide, {
      evaluation: true,
    });
    expect(asked.evaluation).toBe(false);
  });
});

describe("scenario levels", () => {
  test("every scenario sets up on seeds 1–10", () => {
    for (const scenario of SCENARIOS)
      for (let seed = 1; seed <= 10; seed++)
        expect(() => driving.create(seed, scenario.id)).not.toThrow();
  });

  for (const scenario of SCENARIOS.filter((s) => s.id !== "stop-line"))
    test(`the rule passes ${scenario.id}`, async () => {
      const run = driving.create(1, scenario.id);
      let outcome = driving.outcome(run);
      while (!outcome.finished)
        outcome = (
          await playTurn(driving, run, (r: Request) =>
            decideWith(drivingRule, r, options("baseline")),
          )
        ).outcome;
      expect(outcome.passed).toBe(true);
      expect(outcome.metrics.collisions).toBe(0);
    }, 60_000);

  test("a scenario is the same run for the same seed and answers", async () => {
    const play = async () => {
      const run = driving.create(2, "stop-sign");
      for (let i = 0; i < 30; i++)
        await playTurn(driving, run, (r: Request) =>
          decideWith(randomDecider(), r, options("uniform", 2)),
        );
      return [run.sim.player.x, run.sim.player.z, run.sim.time];
    };
    expect(await play()).toEqual(await play());
  }, 30_000);
});
