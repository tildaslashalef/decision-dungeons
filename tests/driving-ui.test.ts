import { describe, expect, test } from "bun:test";
import { Playback } from "../src/dungeons/driving/ui/playback.ts";
import type { Snapshot } from "../src/dungeons/driving/ui/protocol.ts";
import { generateWorld } from "../src/dungeons/driving/world/world.ts";
import { serveAsset, serveWorker } from "../src/server/assets.ts";

function snapshot(
  t: number,
  x: number,
  extra: Partial<Snapshot> = {},
): Snapshot {
  return {
    t,
    distance: x,
    player: {
      id: "ego",
      type: "car",
      x,
      z: 0,
      heading: Math.PI / 2,
      speed: 10,
      steering: 0,
      wheelSteering: 0,
      target: 10,
    },
    traffic: [],
    pedestrians: [],
    crash: null,
    brakeReason: null,
    routeVersion: 0,
    nav: {
      remaining_m: 100,
      route_version: 0,
      rerouted: false,
      route_offset_m: 0,
      heading_error_deg: 0,
      lookahead: { x: 0, z: 0 },
      next_turn: "straight",
      turn_distance_m: 50,
      destination: { id: "d", x: 0, z: 0, s: 0 },
    },
    recovering: false,
    onRoad: true,
    outcome: { finished: false, violations: 0, metrics: {}, records: [] },
    events: [],
    offsets: {},
    ...extra,
  };
}

describe("playback", () => {
  const world = generateWorld(1, "town");

  test("interpolates poses between snapshots by the playback clock", () => {
    const view = new Playback(world, snapshot(0, 0), [], []);
    view.push(snapshot(0.05, 0.5));
    view.push(snapshot(0.1, 1));
    // Rate eases up from rest; run long enough to reach real speed, then sample.
    for (let i = 0; i < 4; i++) view.advance(0.0125, "turn", true);
    expect(view.now).toBeGreaterThan(0);
    expect(view.now).toBeLessThan(0.1);
    expect(view.player.x).toBeCloseTo(view.now * 10, 6);
    expect(view.distance).toBeCloseTo(view.now * 10, 6);
  });

  test("never plays past the newest snapshot, and eases to a halt as the buffer drains", () => {
    const view = new Playback(world, snapshot(0, 0), [], []);
    for (let i = 1; i <= 6; i++) view.push(snapshot(i * 0.05, i * 0.5));
    const steps: number[] = [];
    let before = view.now;
    for (let i = 0; i < 120; i++) {
      view.advance(1 / 60, "turn", false);
      steps.push(view.now - before);
      before = view.now;
    }
    expect(view.now).toBeLessThanOrEqual(view.head);
    expect(view.now).toBeGreaterThan(0.25);
    // No sudden stop: while the car visibly moves (over 5% of its peak
    // travel per frame), each frame keeps most of the previous one's travel.
    const peak = Math.max(...steps);
    const after = steps
      .slice(steps.indexOf(peak))
      .filter((d) => d > peak * 0.05);
    expect(after.length).toBeGreaterThan(5);
    for (let i = 1; i < after.length; i++)
      expect(after[i] as number).toBeGreaterThan(
        (after[i - 1] as number) * 0.7,
      );
  });

  test("holds still while paused", () => {
    const view = new Playback(world, snapshot(0, 0), [], []);
    view.push(snapshot(0.3, 3));
    view.paused = true;
    view.advance(0.1, "turn", false);
    expect(view.now).toBe(0);
  });

  test("applies the signal offsets a run sets", () => {
    const node = world.nodes.find((n) => n.control === "signal");
    if (!node) throw new Error("no signal in this world");
    const view = new Playback(
      world,
      snapshot(0, 0, { offsets: { [node.id]: 7.5 } }),
      [],
      [],
    );
    view.advance(0, "turn", false);
    expect(view.world.byId[node.id]?.offset).toBe(7.5);
  });
});

describe("static assets", () => {
  test("serves the asset directories and refuses everything else", async () => {
    expect((await serveAsset("/textures/LICENSE.md")).status).toBe(200);
    expect((await serveAsset("/models/model-y/ATTRIBUTION.md")).status).toBe(
      200,
    );
    for (const path of [
      "/models/../../package.json",
      "/models/%2e%2e/%2e%2e/package.json",
      "/src/server/app.ts",
      "/textures/missing.jpg",
      "/models/%00",
    ])
      expect((await serveAsset(path)).status).toBeGreaterThanOrEqual(400);
  });

  test("bundles the simulation worker and nothing else", async () => {
    const res = await serveWorker("driving-sim.js", false);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("postMessage");
    expect((await serveWorker("other.js", false)).status).toBe(404);
  }, 20_000);
});
