// Proves the driving port against the reference simulator (NOTICE.md):
// runs its simulation and ours side by side with the same deterministic
// rule, compares every decision (all must be bit-identical), and
// prints one JSON line per run. The reference checkout is read from
// DRIVING_REFERENCE; this is a development check, not part of `bun test`.
//
//   DRIVING_REFERENCE=<checkout> bun scripts/driving-reference.ts town 1        # one trip
//   DRIVING_REFERENCE=<checkout> bun scripts/driving-reference.ts stop-line 42  # the stop-line check
//   DRIVING_REFERENCE=<checkout> bun scripts/driving-reference.ts all           # seeds 1–4 per world, and the check

import { join } from "node:path";
import { decideWith } from "../src/contract/decider.ts";
import type { Request } from "../src/contract/request.ts";
import {
  decideByRule,
  drivingRule,
} from "../src/dungeons/driving/decide/rule.ts";
import { type DrivingRun, driving } from "../src/dungeons/driving/driving.ts";
import { playTurn } from "../src/dungeons/turn.ts";

const root = process.env.DRIVING_REFERENCE;
if (!root) {
  console.error("set DRIVING_REFERENCE to the reference simulator's checkout");
  process.exit(2);
}
// The reference is untyped JavaScript, read as a reference only.
const { Simulation } = await import(join(root, "src/simulation.js"));
const { pointAt } = await import(join(root, "src/math.js"));
const { evaluate } = await import(join(root, "server/jev.js"));

/** Our rule over the reference's own request: the same function on both sides. */
const referenceRule = {
  source: "rule",
  priced: false,
  async decide(body: string) {
    return {
      answers: decideByRule(JSON.parse(body) as Request),
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  },
};

interface Sample {
  t: number;
  x: number;
  z: number;
  heading: number;
  speed: number;
  steering: number;
  target: number;
}

// biome-ignore lint/suspicious/noExplicitAny: the reference simulation is untyped.
type ReferenceSim = any;

const sample = (sim: ReferenceSim | DrivingRun["sim"]): Sample => ({
  t: sim.time,
  x: sim.player.x,
  z: sim.player.z,
  heading: sim.player.heading,
  speed: sim.player.speed,
  steering: sim.player.steering ?? 0,
  target: sim.player.target ?? 0,
});

/** The reference's own headless loop (its scripts/verify-jev.mjs, verify-stop-line.mjs). */
async function reference(level: string, seed: number) {
  const trace: Sample[] = [];
  if (level === "stop-line") {
    const sim = new Simulation(seed, "town");
    const v = sim.player;
    sim.traffic = [];
    sim.pedestrians = [];
    sim.autopilot = true;
    const crossing = v.route.crossings.find(
      (c: ReferenceSim) => sim.world.byId[c.nodeId].control === "signal",
    );
    const node = sim.world.byId[crossing.nodeId];
    const northSouth = Math.abs(Math.cos(crossing.approach)) > 0.5;
    v.s = crossing.stopS - 65;
    Object.assign(v, pointAt(v.route.points, v.s));
    v.heading = crossing.approach;
    let stopped: number | null = null;
    for (let calls = 0; calls < 100; calls++) {
      node.offset = (northSouth ? 12 : 2) - sim.time;
      sim.scanScene();
      const state = sim.decisionState();
      const a = await evaluate(state, {}, undefined, undefined, referenceRule);
      v.maneuver = state.vectors[a.selection.choice];
      v.steering = a.controls.steering;
      v.target = a.controls.velocity;
      for (let i = 0; i < 6; i++) {
        node.offset = (northSouth ? 12 : 2) - sim.time;
        sim.step(0.05);
      }
      trace.push(sample(sim));
      if (v.speed < 0.1 && calls > 0) {
        stopped = crossing.stopS - v.s;
        break;
      }
    }
    let resumed: boolean | null = null;
    if (stopped !== null) {
      node.offset = (northSouth ? 2 : 12) - sim.time;
      sim.scanScene();
      const a = await evaluate(
        sim.decisionState(),
        {},
        undefined,
        undefined,
        referenceRule,
      );
      resumed = a.controls.velocity > 0;
    }
    return {
      trace,
      stopped,
      resumed,
      collisions: sim.collisions,
      violations: sim.violations,
      arrived: null,
    };
  }
  const sim = new Simulation(seed, level);
  sim.autopilot = true;
  let calls = 0;
  while (!sim.complete && !sim.crash && calls < 600) {
    const state = sim.decisionState();
    const d = await evaluate(state, {}, undefined, undefined, referenceRule);
    calls++;
    sim.player.maneuver = state.vectors[d.selection.choice];
    sim.player.steering = d.controls.steering;
    sim.player.target = d.controls.velocity;
    for (let i = 0; i < 6; i++) sim.step(0.05);
    trace.push(sample(sim));
  }
  return {
    trace,
    stopped: null,
    resumed: null,
    collisions: sim.collisions,
    violations: sim.violations,
    arrived: sim.complete,
  };
}

/** The port, through the same decision path the server and CLI use. */
async function port(level: string, seed: number) {
  const run = driving.create(seed, level);
  const trace: Sample[] = [];
  const decide = (request: Request) =>
    decideWith(drivingRule, request, {
      model: "baseline",
      signal: AbortSignal.timeout(10_000),
    });
  let outcome = driving.outcome(run);
  while (!outcome.finished) {
    const before = run.scenario?.facts().phase;
    outcome = (await playTurn(driving, run, decide)).outcome;
    if (before !== "green") trace.push(sample(run.sim));
  }
  return { trace, outcome, run };
}

async function compare(level: string, seed: number) {
  const started = performance.now();
  const ref = await reference(level, seed);
  const ours = await port(level, seed);
  let divergence: {
    decision: number;
    field: string;
    reference: number;
    port: number;
  } | null = null;
  const length = Math.max(ref.trace.length, ours.trace.length);
  for (let i = 0; i < length && !divergence; i++) {
    const a = ref.trace[i];
    const b = ours.trace[i];
    if (!a || !b) {
      divergence = {
        decision: i + 1,
        field: "length",
        reference: ref.trace.length,
        port: ours.trace.length,
      };
      break;
    }
    for (const field of Object.keys(a) as (keyof Sample)[])
      if (!Object.is(a[field], b[field])) {
        divergence = {
          decision: i + 1,
          field,
          reference: a[field],
          port: b[field],
        };
        break;
      }
  }
  const m = ours.outcome.metrics;
  const sim = ours.run.sim;
  const portStop = m.stopped_center_m;
  const result = {
    level,
    seed,
    identical: !divergence,
    divergence,
    decisions: { reference: ref.trace.length, port: ours.trace.length },
    reference: {
      arrived: ref.arrived,
      collisions: ref.collisions,
      violations: ref.violations,
      ...(ref.stopped !== null
        ? {
            stopped_center_m: Number(ref.stopped.toFixed(2)),
            resumed: ref.resumed,
          }
        : {}),
    },
    port: {
      arrived: level === "stop-line" ? null : sim.complete,
      collisions: sim.collisions,
      violations: sim.violations,
      ...(portStop !== undefined
        ? {
            stopped_center_m: portStop,
            resumed: ours.run.scenario?.facts().resumed,
          }
        : {}),
      passed: ours.outcome.passed,
    },
    seconds: Math.round((performance.now() - started) / 100) / 10,
  };
  console.log(JSON.stringify(result));
  return result;
}

const [what = "all", seedArg] = process.argv.slice(2);
const runs: [string, number][] =
  what === "all"
    ? [
        ...["town", "city", "highway"].flatMap((w) =>
          [1, 2, 3, 4].map((s): [string, number] => [w, s]),
        ),
        ["stop-line", 42],
      ]
    : [[what, Number(seedArg ?? (what === "stop-line" ? 42 : 1))]];
let failed = false;
for (const [level, seed] of runs) {
  const r = await compare(level, seed);
  if (!r.identical) failed = true;
}
if (failed) process.exitCode = 1;
