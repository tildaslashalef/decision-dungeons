// The driving simulation: the world, the player's car, traffic, and
// pedestrians, advanced in fixed steps. Headless and deterministic: two
// seeded generators (population, planning) are its only randomness.
// Rules, navigation, perception, and the decision state live in their own
// modules and read this state.

import { pick, type Rng, seeded } from "../../../lib/random.ts";
import type { DecisionState } from "../decide/state.ts";
import {
  angle,
  clamp,
  dist,
  heading,
  last,
  move,
  nearestOnPath,
  type PathPoint,
  type Point,
  pointAt,
  round,
} from "../world/geometry.ts";
import { shortestPath, signalState } from "../world/grid.ts";
import type { RouteChoice } from "../world/reroute.ts";
import type { Building, Junction, World, WorldType } from "../world/types.ts";
import { generateWorld, makeRoute } from "../world/world.ts";
import {
  collisionPose,
  firstCollision,
  type Shape,
  type Sweep,
} from "./collisions.ts";
import { updateCourtesy } from "./courtesy.ts";
import { rerouteIfNeeded } from "./navigation.ts";
import { type Seen, scanScene } from "./perception.ts";
import type { DrivingPlan } from "./plan.ts";
import { recoveryBlocked } from "./plan.ts";
import { rule, speedEnvelope } from "./rules.ts";
import type { Car, Obstacle, Pedestrian } from "./types.ts";
import {
  maneuverSteering,
  maneuverVelocity,
  pedalPhysics,
  physics,
} from "./vehicle.ts";

export const REROUTE_DISTANCE_M = 30;

const TRAFFIC_COLORS = [
  "#de8e69",
  "#e9be57",
  "#97b6b9",
  "#efefe2",
  "#658f82",
  "#a294bf",
];

export interface SimEvent {
  time: number;
  text: string;
  type: "info" | "error" | "success";
}

export interface Crash {
  object_id: string;
  type: string;
  time_s: number;
  impact_speed_mps: number;
  player_speed_mps: number;
  point: Point;
  normal: Point;
}

export interface Grant {
  id: string;
  at: number;
}

export class Simulation {
  world!: World;
  /** Static obstacles, in world order. */
  buildings!: Building[];
  time = 0;
  paused = false;
  autopilot = false;
  /** The safety brake and the recovery clearance check. */
  safety = true;
  /**
   * Evaluation mode: candidates are sampled up to the road's own speed
   * bound rather than the traffic taper, and those predicted to collide
   * stay eligible, so the decider's choice, not the planner, decides the
   * outcome. Set with `safety` off by the dungeon.
   */
  evaluation = false;
  /**
   * Offer a stop at the line while the junction's rules make the player
   * yield (an earlier arrival, crossing traffic). The reference simulator never offered
   * it, so default trips leave it off; scenario levels and evaluation mode
   * turn it on.
   */
  yieldStops = false;
  /** Traffic a scenario holds in place: skipped by the traffic step. */
  frozen = new Set<string>();
  pedals = { throttle: 0, brake: 0 };
  steeringInput = 0;
  brakeReason: string | null = null;
  complete = false;
  collisions = 0;
  crash: Crash | null = null;
  violations = 0;
  distance = 0;
  freeExplore = false;
  events: SimEvent[] = [];
  /** Junction reservations: who may enter. */
  locks = new Map<string, Grant>();
  /** Deadlock releases at stop signs. */
  courtesy = new Map<string, Grant>();
  nextCourtesy = 0;
  /** Population randomness: spawns, pedestrians, traffic's onward routes. */
  r!: Rng;
  /** Planning randomness: candidate sampling. */
  planRandom!: Rng;
  planSequence = 0;
  routeVersion = 0;
  routeChoices: Record<string, RouteChoice> = {};
  nextRouteChoices = 0;
  routeChoicesOrigin: Point | null = null;
  routeHoldUntil = 0;
  nextRouteCheck = 0;
  offRouteSince: number | null = null;
  lastReroute = Number.NEGATIVE_INFINITY;
  destinationApproach!: string[];
  destinationPoint!: PathPoint;
  lastPlan: DrivingPlan | null = null;
  lastDecisionState: DecisionState | null = null;
  contacts = new Set<string>();
  discovered = new Map<
    string,
    { first_seen_s: number; last_seen_s: number; type: string }
  >();
  perception: Seen[] = [];
  nextScan = 0;
  sensorRange = 80;
  player!: Car;
  traffic: Car[] = [];
  pedestrians: Pedestrian[] = [];

  constructor(seed: number, type: WorldType = "town") {
    this.reset(seed, type);
  }

  reset(seed: number, type: WorldType): void {
    this.world = generateWorld(seed, type);
    this.buildings = this.world.objects.filter(
      (o): o is Building => o.type === "building",
    );
    this.r = seeded(seed + 51);
    this.planRandom = seeded(seed + 9173);
    this.destinationApproach = this.world.route.ids.slice(-2);
    this.destinationPoint = { ...last(this.world.route.points) };
    const p = this.world.route.points[0] as PathPoint;
    const h = heading(p, this.world.route.points[1] as PathPoint);
    this.player = {
      id: "ego",
      type: "car",
      x: p.x,
      z: p.z,
      heading: h,
      speed: 0,
      steering: 0,
      steeringProgress: 0,
      target: 0,
      route: this.world.route,
      s: 0,
      stops: {},
      intersectionMemory: null,
      width: 1.9,
      depth: 4.75,
    };
    this.traffic = [];
    for (let i = 0; i < this.world.theme.traffic; i++) this.spawnTraffic(i);
    this.pedestrians = [];
    const walkers = type === "highway" ? 0 : 14 + (type === "city" ? 12 : 0);
    for (let i = 0; i < walkers; i++)
      this.pedestrians.push(this.newPedestrian(i));
  }

  private newPedestrian(i: number): Pedestrian {
    const node = pick(this.r, this.world.nodes);
    const crossing = i % 3 === 0 && node.control === "signal";
    const other = this.world.byId[pick(this.r, node.neighbors)] as Junction;
    const walkHeading = heading(node, other);
    const side = this.r() < 0.5 ? -1 : 1;
    const pathStart = move(
      move(node, walkHeading, 14),
      walkHeading + Math.PI / 2,
      7.05 * side,
    );
    const pathLength = dist(node, other) - 28;
    const progress = crossing ? 0 : this.r() * pathLength;
    const position = crossing
      ? { x: node.x - 8, z: node.z - 7.8 }
      : move(pathStart, walkHeading, progress);
    return {
      id: `pedestrian-${i}`,
      type: "pedestrian",
      nodeId: node.id,
      x: position.x,
      z: position.z,
      progress,
      walkPath: { start: pathStart, heading: walkHeading, length: pathLength },
      direction: this.r() > 0.5 ? 1 : -1,
      crossing,
      walking: false,
      speed: 0,
      width: 0.6,
      depth: 0.6,
      height: 1.7,
    };
  }

  /** Places traffic car `i` somewhere on a random route, away from the player. */
  spawnTraffic(i: number, distant = false): void {
    const highway = this.world.type === "highway";
    const nodes = highway
      ? this.world.nodes.filter((node) => /^h\d+$/.test(node.id))
      : this.world.nodes;
    const a = pick(this.r, nodes);
    const b = pick(
      this.r,
      nodes.filter((n) => dist(n, a) > 100),
    );
    const ids = highway
      ? (i % 4 < 2 ? nodes : [...nodes].reverse()).map((node) => node.id)
      : shortestPath(this.world, a.id, b.id);
    if (ids.length < 3) {
      this.spawnTraffic(i, distant);
      return;
    }
    const route = makeRoute(
      this.world,
      ids,
      highway && i % 2 === 0 ? 4.5 : undefined,
    );
    const s = this.r() * route.length;
    const p = pointAt(route.points, s);
    const next = pointAt(route.points, s + 1);
    if (dist(p, this.player) < (distant ? 600 : 15)) {
      this.spawnTraffic(i, distant);
      return;
    }
    const existing = this.traffic.find((v) => v.id === `vehicle-${i}`);
    if (this.traffic.some((v) => v !== existing && dist(v, p) < 10)) return;
    const motorcycle = i % 5 === 0;
    const v: Car = {
      id: `vehicle-${i}`,
      type: motorcycle ? "motorcycle" : "car",
      x: p.x,
      z: p.z,
      heading: heading(p, next),
      speed: 0,
      s,
      route,
      stops: {},
      width: motorcycle ? 0.8 : 1.9,
      depth: motorcycle ? 2.3 : 4.2,
      color: pick(this.r, TRAFFIC_COLORS),
    };
    if (existing) Object.assign(existing, v);
    else this.traffic.push(v);
  }

  /**
   * Extends a grid car's route before it runs out, from its current last
   * street, so lane position and heading carry over.
   */
  private continueTraffic(v: Car): void {
    if (this.world.type === "highway") return;
    const ids = v.route.ids.slice(-2);
    for (let i = 0; i < 5; i++) {
      const node = this.world.byId[last(ids)] as Junction;
      const forward = node.neighbors.filter((id) => id !== ids[ids.length - 2]);
      ids.push(pick(this.r, forward.length ? forward : node.neighbors));
    }
    const route = makeRoute(this.world, ids);
    const near = nearestOnPath(v, route.points);
    if (near.distance > 0.5) return;
    v.route = route;
    v.s = near.s;
    v.stops = {};
    v.amber = null;
  }

  event(text: string, type: SimEvent["type"] = "info"): void {
    if (this.events[0]?.text === text && this.time - this.events[0].time < 3)
      return;
    this.events.unshift({ time: round(this.time, 1), text, type });
    this.events = this.events.slice(0, 30);
  }

  /** Advances the world by `dt` seconds (at most 0.05). */
  step(dtIn: number): void {
    if (this.paused || this.crash) return;
    const previous = new Map(
      [...this.traffic, ...this.pedestrians].map((o) => [
        o.id,
        { pose: collisionPose(o), route: "route" in o ? o.route : undefined },
      ]),
    );
    const firstStep = this.time === 0;
    const dt = Math.min(dtIn, 0.05);
    this.time += dt;
    rerouteIfNeeded(this);
    for (const [id, lock] of this.locks) {
      const car = [this.player, ...this.traffic].find((c) => c.id === lock.id);
      const node = this.world.byId[id] as Junction;
      if (!car || dist(car, node) > 17 || this.time - lock.at > 7)
        this.locks.delete(id);
    }
    this.stepPedestrians(dt);
    updateCourtesy(this);
    this.stepTraffic(dt);
    if (this.time >= this.nextScan) {
      scanScene(this);
      this.nextScan = this.time + 0.2;
    }
    this.stepPlayer(dt, previous, firstStep);
  }

  private stepPedestrians(dt: number): void {
    for (const p of this.pedestrians) {
      const node = this.world.byId[p.nodeId] as Junction;
      const walk = signalState(node, this.time, 0).walk;
      if (p.crossing) {
        if (walk && !p.walking && p.progress === 0) {
          const anyCar = [this.player, ...this.traffic].some(
            (v) => dist(v, node) < 13,
          );
          if (!anyCar) p.walking = true;
        }
        if (p.walking) {
          p.progress += dt * 3.8;
          if (p.progress >= 16) {
            p.progress = 0;
            p.walking = false;
            p.direction *= -1;
          }
        } else if (p.progress > 0) {
          p.progress = 0;
        }
        p.x = node.x + (p.direction > 0 ? -8 + p.progress : 8 - p.progress);
        p.z = node.z - 7.8;
        p.speed = p.walking ? 3.8 : 0;
        p.heading = p.direction > 0 ? Math.PI / 2 : -Math.PI / 2;
      } else {
        p.progress += dt * 0.9 * p.direction;
        if (p.progress > p.walkPath.length || p.progress < 0) {
          p.progress = clamp(p.progress, 0, p.walkPath.length);
          p.direction *= -1;
        }
        const position = move(p.walkPath.start, p.walkPath.heading, p.progress);
        p.x = position.x;
        p.z = position.z;
        p.walking = true;
        p.speed = 0.9;
        p.heading = angle(p.walkPath.heading + (p.direction < 0 ? Math.PI : 0));
      }
    }
  }

  private stepTraffic(dt: number): void {
    for (const v of this.traffic) {
      if (this.frozen.has(v.id)) {
        v.speed = 0;
        continue;
      }
      if (v.route.length - v.s < 75) this.continueTraffic(v);
      const r = rule(this, v, true);
      let target = speedEnvelope(this, v).max;
      const next = pointAt(v.route.points, v.s + 9);
      const h = heading(v, next);
      if (v.s < v.route.length - 1 && Math.abs(angle(h - v.heading)) > 0.2)
        target = Math.min(target, 6.5);
      v.speed += clamp(target - v.speed, -7 * dt, 2.8 * dt);
      if (
        r.mustStop &&
        r.distance >= 0 &&
        v.speed * dt > Math.max(0, r.distance - v.depth / 2 - 0.2)
      )
        v.speed = Math.max(0, r.distance - v.depth / 2 - 0.2) / dt;
      v.s += v.speed * dt;
      if (v.s >= v.route.length - 1) {
        // Interstate traffic drives on past the map and respawns only out of
        // sight: no teleport at a route's end in view.
        if (dist(v, this.player) > 1300)
          this.spawnTraffic(Number(v.id.split("-")[1]), true);
        else {
          v.x += Math.sin(v.heading) * v.speed * dt;
          v.z -= Math.cos(v.heading) * v.speed * dt;
        }
        continue;
      }
      const p = pointAt(v.route.points, v.s);
      const ahead = pointAt(v.route.points, v.s + 0.5);
      v.x = p.x;
      v.z = p.z;
      v.heading = heading(p, ahead);
    }
  }

  private stepPlayer(
    dt: number,
    previous: Map<string, { pose: Shape; route: unknown }>,
    firstStep: boolean,
  ): void {
    const v = this.player;
    const old = { ...collisionPose(v), s: v.s };
    const currentRule = rule(this, v, true);
    const maneuver = v.maneuver;
    if (
      maneuver?.stop_at_line?.node_id === currentRule.nodeId &&
      (currentRule.color === "green" || currentRule.stopCompleted)
    ) {
      // A line-stop profile ends with a green light or a served stop; the
      // chosen speed cap holds until the next decision.
      v.maneuver = {
        lane_offset_m: null,
        lookahead_m: null,
        ...maneuver,
        stop_at_line: null,
      };
    }
    let target = this.autopilot
      ? maneuverVelocity(v, v.maneuver, v.target as number)
      : (v.target as number);
    this.brakeReason = null;
    if (this.autopilot && this.safety) {
      if (this.lastPlan?.recovery.active) {
        target = clamp(target, -2, 2);
        if (
          recoveryBlocked(v, v.steering as number, target, [
            ...this.buildings,
            ...this.traffic,
            ...this.pedestrians,
          ])
        ) {
          target = 0;
          this.brakeReason = "Recovery clearance";
        }
      } else {
        const env = speedEnvelope(this, v);
        if (target > env.max) {
          target = env.max;
          this.brakeReason = env.reason;
        }
      }
    }
    if (this.complete) target = 0;
    v.appliedTarget = target;
    if (this.autopilot || this.complete) {
      const steering = v.maneuver
        ? maneuverSteering(v, v.maneuver)
        : (v.steering as number);
      physics(v, steering, target, dt);
    } else
      pedalPhysics(
        v,
        this.steeringInput,
        this.pedals.throttle,
        this.pedals.brake,
        dt,
      );
    v.x = clamp(v.x, this.world.bounds.minX, this.world.bounds.maxX);
    v.z = clamp(v.z, this.world.bounds.minZ, this.world.bounds.maxZ);
    const sweeps: Sweep<Obstacle>[] = [
      ...this.buildings.map((object) => ({ object })),
      ...[...this.traffic, ...this.pedestrians].map((object) => {
        const before = previous.get(object.id);
        // Fresh spawns and the initial placement are teleports, not motion.
        const moved =
          !firstStep &&
          before?.route === ("route" in object ? object.route : undefined);
        return { object, previous: moved ? (before?.pose ?? null) : null };
      }),
    ];
    const hit = firstCollision(old, collisionPose(v), sweeps);
    if (hit) {
      Object.assign(v, {
        x: hit.player.x,
        z: hit.player.z,
        heading: hit.player.heading,
      });
      if (hit.object.type !== "building") {
        Object.assign(hit.object, {
          x: hit.target.x,
          z: hit.target.z,
          heading: hit.target.heading,
          speed: 0,
          walking: false,
        });
      }
      this.distance += dist(old, v);
      v.s = nearestOnPath(v, v.route.points).s;
      this.crash = {
        object_id: hit.object.id,
        type: hit.object.type,
        time_s: round(this.time, 2),
        impact_speed_mps: round(hit.relativeSpeed, 2),
        player_speed_mps: round(Math.abs(v.speed), 2),
        point: hit.point,
        normal: hit.normal,
      };
      v.speed = 0;
      v.target = 0;
      v.steering = 0;
      this.autopilot = false;
      this.complete = false;
      this.collisions++;
      this.contacts = new Set([hit.object.id]);
      this.event(`Collision with ${hit.object.type} — drive ended`, "error");
      return;
    }
    this.contacts.clear();
    this.distance += dist(old, v);
    const near = nearestOnPath(v, v.route.points);
    v.s = near.s;
    // Rejoining resets the departure at once, even mid-calculation.
    if (near.distance <= REROUTE_DISTANCE_M && this.offRouteSince != null) {
      this.offRouteSince = null;
      this.routeChoices = {};
      this.routeChoicesOrigin = null;
    }
    for (const c of v.route.crossings) {
      if (old.s < c.stopS && v.s >= c.stopS && near.distance < 4) {
        const node = this.world.byId[c.nodeId] as Junction;
        if (
          node.control === "signal"
            ? signalState(node, this.time, c.approach).color === "red"
            : !v.stops[node.id]?.served
        ) {
          this.violations++;
          this.event(
            node.control === "stop" ? "Missed stop sign" : "Crossed on red",
            "error",
          );
        }
      }
    }
    if (
      !this.complete &&
      !this.freeExplore &&
      dist(v, last(v.route.points)) < 3 &&
      v.speed < 1
    ) {
      this.complete = true;
      v.target = 0;
      this.autopilot = false;
      this.event("Destination reached. Nicely driven.", "success");
    }
  }
}
