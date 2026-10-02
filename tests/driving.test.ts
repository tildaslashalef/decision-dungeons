import { describe, expect, test } from "bun:test";
import { decideWith } from "../src/contract/decider.ts";
import type { Request } from "../src/contract/request.ts";
import { parseRequest, validateAnswers } from "../src/contract/validate.ts";
import { bulkLast } from "../src/deciders/nuclis.ts";
import { randomDecider } from "../src/deciders/random.ts";
import {
  decideByRule,
  drivingRule,
} from "../src/dungeons/driving/decide/rule.ts";
import { driving } from "../src/dungeons/driving/driving.ts";
import { generateWorld } from "../src/dungeons/driving/world/world.ts";
import { playTurn } from "../src/dungeons/turn.ts";

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

test("the same seed and answers replay the same run", async () => {
  const play = async () => {
    const run = driving.create(5, "highway");
    for (let i = 0; i < 12; i++)
      await playTurn(driving, run, (r: Request) =>
        decideWith(randomDecider(), r, options("uniform", 5)),
      );
    return {
      x: run.sim.player.x,
      z: run.sim.player.z,
      speed: run.sim.player.speed,
      t: run.sim.time,
    };
  };
  expect(await play()).toEqual(await play());
});
