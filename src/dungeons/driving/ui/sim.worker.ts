// The driving run, off the main thread. Planning a decision (55 rollouts
// with swept collision checks) and stepping the world never block a
// frame. Turn-based: the stage asks for an observation, sends the answers,
// and asks for the turn's six 50 ms steps, which come back as snapshots to
// play over wall time. Real-time: the worker steps on its own clock and
// streams a snapshot per tick.

import type { Answers } from "../../../contract/answer.ts";
import { expandAnswers } from "../decide/request.ts";
import {
  type DrivingAnswers,
  decisionOptions,
  decisionSelection,
  type Selection,
} from "../decide/selection.ts";
import {
  type DrivingRun,
  driving,
  STEP_S,
  settleTurn,
  TURN_STEPS,
} from "../driving.ts";
import { navigation } from "../sim/navigation.ts";
import { worldObservation } from "../sim/observation.ts";
import { visibleObjects } from "../sim/perception.ts";
import type { CarLook, FromWorker, Snapshot, ToWorker } from "./protocol.ts";

/** Real-time ticks: the physics substep and the tick interval. */
const SUBSTEP_S = 0.025;
const TICK_MS = 16;
/** Real-time: an answer older than this (ms) no longer drives; the car's target speed drops to zero. */
const STALE_MS = 1800;

let run: DrivingRun | null = null;
let routeVersion = -1;
let looks = "";
let ticker: ReturnType<typeof setInterval> | null = null;
let lastTick = 0;
let lastApplied = 0;

const post = (message: FromWorker) => postMessage(message);

function snapshot(r: DrivingRun): Snapshot {
  const sim = r.sim;
  const v = sim.player;
  const offsets: Record<string, number> = {};
  if (r.check) offsets[r.check.node.id] = r.check.node.offset;
  return {
    t: sim.time,
    distance: sim.distance,
    player: {
      id: v.id,
      type: v.type,
      x: v.x,
      z: v.z,
      heading: v.heading,
      speed: v.speed,
      steering: v.steering ?? 0,
      wheelSteering: v.wheelSteering ?? v.steering ?? 0,
      target: v.target ?? 0,
    },
    traffic: sim.traffic.map((c) => ({
      id: c.id,
      type: c.type,
      x: c.x,
      z: c.z,
      heading: c.heading,
      speed: c.speed,
    })),
    pedestrians: sim.pedestrians.map((p) => ({
      id: p.id,
      x: p.x,
      z: p.z,
      heading: p.heading ?? 0,
      walking: p.walking,
      crossing: p.crossing,
    })),
    crash: sim.crash,
    brakeReason: sim.brakeReason,
    routeVersion: sim.routeVersion,
    nav: navigation(sim),
    recovering: !!sim.lastPlan?.recovery.active,
    onRoad: sim.lastPlan?.road.on_road ?? true,
    outcome: driving.outcome(r),
    events: sim.events.slice(0, 5),
    offsets,
  };
}

/** Announces a new route or new traffic looks, once each. */
function announce(r: DrivingRun): void {
  if (r.sim.routeVersion !== routeVersion) {
    routeVersion = r.sim.routeVersion;
    post({
      type: "route",
      version: routeVersion,
      route: r.sim.player.route.points,
    });
  }
  const current: CarLook[] = r.sim.traffic.map((c) => ({
    id: c.id,
    type: c.type,
    color: c.color ?? "#d6d9df",
  }));
  const key = current.map((c) => `${c.id}:${c.color}`).join(",");
  if (key !== looks) {
    looks = key;
    post({ type: "looks", looks: current });
  }
}

function stopTicker(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

function tick(): void {
  if (!run) return;
  const now = performance.now();
  const dt = Math.min((now - lastTick) / 1000, 0.2);
  if (now - lastApplied > STALE_MS) run.sim.player.target = 0;
  lastTick = now;
  if (driving.outcome(run).finished) return;
  const steps = Math.max(1, Math.ceil(dt / SUBSTEP_S));
  for (let i = 0; i < steps; i++) driving.step(run, dt / steps);
  announce(run);
  post({ type: "tick", snapshot: snapshot(run) });
}

function handle(message: ToWorker): void {
  if (message.type === "start") {
    stopTicker();
    run = driving.create(message.seed, message.level);
    routeVersion = run.sim.routeVersion;
    const current = run.sim.traffic.map((c) => ({
      id: c.id,
      type: c.type,
      color: c.color ?? "#d6d9df",
    }));
    looks = current.map((c) => `${c.id}:${c.color}`).join(",");
    post({
      type: "started",
      snapshot: snapshot(run),
      route: run.sim.player.route.points,
      looks: current,
    });
    return;
  }
  if (!run) return;
  const r = run;
  switch (message.type) {
    case "observe": {
      const observation = driving.observe(r);
      const pending = r.pending;
      if (!pending) return;
      post({
        type: "observed",
        request: observation.request,
        resolved: observation.resolved ?? {},
        state: pending.state,
        plan: r.sim.lastPlan,
        snapshot: snapshot(r),
      });
      return;
    }
    case "apply": {
      const pending = r.pending;
      let selection: Selection | null = null;
      if (pending) {
        const answers: Answers = message.answers;
        const expanded = expandAnswers(
          pending.prepared,
          answers,
        ) as DrivingAnswers;
        selection = decisionSelection(pending.state, expanded);
        if (!selection) {
          // Answers without a distribution still choose; nothing to display.
          const choice =
            expanded.motion?.choice === "drive"
              ? expanded.vector?.choice
              : decisionOptions(pending.state).stopId;
          if (choice)
            selection = {
              choice,
              probabilities: {},
              confidence: Number.NaN,
              probability_basis: "The decider reported no probabilities",
            };
        }
      }
      driving.apply(r, message.answers);
      lastApplied = performance.now();
      if (ticker) settleTurn(r);
      post({ type: "applied", selection, snapshot: snapshot(r) });
      return;
    }
    case "advance": {
      const snapshots: Snapshot[] = [];
      if (r.check?.phase !== "done")
        for (let i = 0; i < TURN_STEPS; i++) {
          driving.step(r, STEP_S);
          snapshots.push(snapshot(r));
        }
      settleTurn(r);
      announce(r);
      // The turn's last snapshot carries the settled check.
      const end = snapshots.at(-1);
      if (end) end.outcome = driving.outcome(r);
      post({ type: "advanced", snapshots });
      return;
    }
    case "realtime": {
      stopTicker();
      if (message.on) {
        lastTick = performance.now();
        ticker = setInterval(tick, TICK_MS);
      }
      return;
    }
    case "perception": {
      const { visible, occluded } = visibleObjects(r.sim);
      post({
        type: "perception",
        data: {
          live_nearby: r.sim.perception,
          sensor_range_m: r.sim.sensorRange,
          visible_objects: visible,
          occluded_ids: occluded,
          discovered_objects: Object.fromEntries(r.sim.discovered),
        },
      });
      return;
    }
    case "world": {
      post({ type: "world", data: worldObservation(r.sim) });
      return;
    }
  }
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  try {
    handle(event.data);
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
