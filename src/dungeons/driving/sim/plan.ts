// A decision's candidate maneuvers. Each is sampled (steering or a lane
// offset, a speed, maybe a stop-at-line profile), rolled out over 3 s, and
// measured: road and lane keeping, route progress, stop-line crossing,
// predicted collisions. A dozen are kept, the best first, plus a stop.

import type { Rng } from "../../../lib/random.ts";
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
  type Pose,
  pointAt,
  round,
} from "../world/geometry.ts";
import {
  distanceToRoad,
  localRoads,
  type Relative,
  type RoadState,
  relativePoint,
  roadOccupancy,
  roadState,
  type Surface,
} from "../world/road.ts";
import type { Building, World } from "../world/types.ts";
import { routeSection } from "../world/world.ts";
import { collisionPose, firstCollision } from "./collisions.ts";
import type { Rule } from "./rules.ts";
import {
  type Blocker,
  createObstaclePrediction,
  followingGap,
  followingSpeed,
  leadVehicle,
  nearbyPathBlocker,
  otherPose,
} from "./traffic.ts";
import type { Car, Maneuver, Obstacle, StopAtLine } from "./types.ts";
import {
  BRAKING,
  CANDIDATE_COUNT,
  type Dynamic,
  maneuverSteering,
  type Projection,
  projectVector,
  steeringForCurvature,
  stopApproachSpeed,
  stopLineDistance,
  VECTOR_HORIZON,
  VECTOR_STEPS,
} from "./vehicle.ts";

/** A candidate maneuver and what its rollout measured; the fields are the decision state's. */
export interface Candidate extends Maneuver {
  steering: number;
  velocity_mps: number;
  stop_at_line: StopAtLine | null;
  queue_compatible: boolean;
  following_vehicle_id: string | null;
  end_speed_mps: number;
  stop_line_after_m: number | null;
  crosses_stop_line: boolean;
  stopping_distance_after_m: number;
  lane_error_m: number;
  lane_error_after_m: number;
  stays_in_lane: boolean;
  returning_to_lane: boolean;
  route_error_m: number;
  route_progress_m: number;
  follows_route_direction: boolean;
  heading_error_deg: number;
  offroad_fraction: number;
  max_offroad_fraction: number;
  stays_on_road: boolean;
  first_offroad: { in_s: number; center: Relative } | null;
  end_position: Relative;
  on_road_after: boolean;
  road_distance_after_m: number;
  recovery_distance_m: number | null;
  collision_predicted: boolean;
  collision_imminent: boolean;
  collision_in_s: number | null;
  collision_object_id: string | null;
}

export interface Queue {
  lead_id: string;
  gap_m: number;
  lead_speed_mps: number;
  target_gap_m: number;
  policy: "follow_in_lane";
}

export interface DrivingPlan {
  batch_id: string;
  origin: Pose & { depth: number };
  vectors: Record<string, Candidate>;
  projections: Record<string, Projection>;
  stopLine: (PathPoint & { heading: number }) | null;
  speedCap: number;
  stopApproach: { stop_line_ahead_m: number; approach_cap_mps: number } | null;
  blockingObject: Blocker | null;
  queue: Queue | null;
  road: RoadState;
  lane: {
    drive_on: "right";
    offset_m: number;
    half_width_m: number;
    centerline: Relative[];
  };
  recovery: {
    active: boolean;
    blocked: boolean;
    speed_cap_mps: number | null;
    target: (Relative & { heading_relative_deg: number }) | null;
  };
  /** The candidates a decider may choose, filled in with the decision state. */
  eligible?: Record<string, Candidate>;
}

/** Whether the segment a→b keeps `padding` clear of every (rotated) building. */
function clearSegment(
  a: Point,
  b: Point,
  buildings: Building[],
  padding: number,
): boolean {
  for (const o of buildings) {
    const h = -(o.rotation || 0);
    const c = Math.cos(h);
    const s = Math.sin(h);
    const local = (p: Point) => ({
      x: (p.x - o.x) * c + (p.z - o.z) * s,
      z: (p.x - o.x) * s - (p.z - o.z) * c,
    });
    const p = local(a);
    const q = local(b);
    let lo = 0;
    let hi = 1;
    for (const [axis, radius] of [
      ["x", o.width / 2 + padding],
      ["z", o.depth / 2 + padding],
    ] as const) {
      const d = q[axis] - p[axis];
      if (Math.abs(d) < 1e-8) {
        if (Math.abs(p[axis]) > radius) {
          lo = 2;
          break;
        }
      } else {
        const ends = [(-radius - p[axis]) / d, (radius - p[axis]) / d].sort(
          (x, y) => x - y,
        ) as [number, number];
        lo = Math.max(lo, ends[0]);
        hi = Math.min(hi, ends[1]);
      }
    }
    if (lo <= hi) return false;
  }
  return true;
}

interface Recovery {
  waypoint: Point;
  goal: Point & { heading?: number };
}

/**
 * Where an off-road car should head: the first on-road route point it can
 * see, or, around buildings, the first leg of a small visibility graph.
 */
export function recoveryTarget(
  car: Car,
  surfaces: Surface[],
  buildings: Building[],
): Recovery | null {
  const near = nearestOnPath(car, car.route.points);
  const targets = [8, 14, 20, 4, 0, -6, 28, -12, 40]
    .map((offset) => {
      const p = pointAt(
        car.route.points,
        clamp(near.s + offset, 0, car.route.length),
      );
      return { ...p, heading: p.heading ?? near.heading };
    })
    .filter((p) => roadOccupancy({ ...car, ...p }, surfaces).on_road);
  const padding = car.width / 2 + 0.25;
  const visible = targets.filter((p) =>
    clearSegment(car, p, buildings, padding),
  );
  if (visible.length) {
    const goal = visible[0] as PathPoint;
    return { waypoint: goal, goal };
  }
  if (!targets.length) return null;
  // A conservative visibility graph around nearby buildings guides sampling;
  // the rollouts still check the real oriented body.
  const radius = Math.min(...targets.map((p) => dist(car, p))) + 30;
  const nearby = buildings
    .filter((o) => dist(car, o) < radius + Math.hypot(o.width, o.depth) / 2)
    .sort((a, b) => dist(car, a) - dist(car, b))
    .slice(0, 12);
  const nodes: (Point & { heading?: number })[] = [car, ...targets];
  for (const o of nearby)
    for (const x of [-1, 1])
      for (const z of [-1, 1]) {
        nodes.push(
          move(
            move(o, -(o.rotation || 0), z * (o.depth / 2 + padding + 0.5)),
            -(o.rotation || 0) + Math.PI / 2,
            x * (o.width / 2 + padding + 0.5),
          ),
        );
      }
  const costs = nodes.map(() => Number.POSITIVE_INFINITY);
  const previous: number[] = [];
  const visited = new Set<number>();
  costs[0] = 0;
  const cost = (i: number) => costs[i] as number;
  const node = (i: number) => nodes[i] as Point;
  for (let step = 0; step < nodes.length; step++) {
    let current = -1;
    for (let i = 0; i < nodes.length; i++)
      if (!visited.has(i) && (current < 0 || cost(i) < cost(current)))
        current = i;
    if (current < 0 || !Number.isFinite(cost(current))) break;
    if (current > 0 && current <= targets.length) {
      let first = current;
      while (previous[first] !== 0) first = previous[first] as number;
      return {
        waypoint: node(first),
        goal: nodes[current] as Point & { heading?: number },
      };
    }
    visited.add(current);
    for (let i = 1; i < nodes.length; i++) {
      if (visited.has(i)) continue;
      const c = cost(current) + dist(node(current), node(i));
      if (
        c < cost(i) &&
        clearSegment(node(current), node(i), buildings, padding)
      ) {
        costs[i] = c;
        previous[i] = current;
      }
    }
  }
  return null;
}

interface Evaluated {
  data: Candidate;
  projection: Projection;
  score: number;
}

/**
 * Samples, rolls out, and ranks the candidates for one decision. Draws from
 * `random` in a fixed order, so a seed and a state give the same batch.
 */
export function createDrivingPlan(
  car: Car,
  world: World,
  obstacles: Obstacle[],
  random: Rng,
  batch: string,
  ceiling: number,
  control: Rule | null = null,
): DrivingPlan {
  const surfaces = localRoads(
    world,
    car,
    Math.max(100, Math.abs(car.speed) * 4),
  );
  const occupancy = roadOccupancy(car, surfaces);
  const near = nearestOnPath(car, car.route.points);
  const recovering =
    !occupancy.on_road ||
    near.distance > 6 ||
    Math.abs(angle(near.heading - car.heading)) > 1.2;
  const section = routeSection(car, near.s);
  const merging = section?.kind === "onramp" || section?.kind === "merge";
  const buildings = obstacles.filter(
    (o): o is Building => o.type === "building",
  );
  const recovery = recovering ? recoveryTarget(car, surfaces, buildings) : null;
  const goal: Point & { heading?: number } =
    recovery?.waypoint ||
    pointAt(car.route.points, near.s + Math.max(5, Math.abs(car.speed) * 1.2));
  const crossing = car.route.crossings.find((c) => c.stopS - near.s > -19);
  const stopLine = crossing
    ? {
        ...pointAt(car.route.points, crossing.stopS),
        heading: crossing.approach,
      }
    : null;
  const crossingControl = crossing
    ? world.byId[crossing.nodeId]?.control
    : undefined;
  const approachingControl =
    crossing &&
    (crossingControl === "stop" || crossingControl === "signal") &&
    crossing.stopS - near.s > -car.depth &&
    crossing.stopS - near.s < 100;
  const requiresStop = !!(
    !recovering &&
    approachingControl &&
    control &&
    control.distance >= -0.7 &&
    ((crossingControl === "stop" && !control.stopCompleted) ||
      (crossingControl === "signal" &&
        (control.color === "red" || control.color === "amber")))
  );
  const line = stopLine as NonNullable<typeof stopLine>;
  const maxSpeed = recovering
    ? 2
    : round(
        Math.min(
          ceiling,
          requiresStop
            ? stopApproachSpeed(car, line)
            : Number.POSITIVE_INFINITY,
        ),
        2,
      );
  const lead = recovering
    ? null
    : leadVehicle(
        car,
        obstacles.filter(
          (o): o is Car => o.type === "car" || o.type === "motorcycle",
        ),
      );
  const queue: Queue | null =
    lead &&
    crossing &&
    (crossingControl === "stop" || crossingControl === "signal") &&
    crossing.stopS - near.s > -3 &&
    crossing.stopS - near.s < 90 &&
    lead.gap < 45 &&
    lead.gap < crossing.stopS - near.s + 8
      ? {
          lead_id: lead.other.id,
          gap_m: round(lead.gap, 1),
          lead_speed_mps: round(lead.other.speed, 1),
          target_gap_m: round(followingGap(car, lead.other), 1),
          policy: "follow_in_lane",
        }
      : null;
  const limitFollowingSpeed = lead
    ? (ghost: Dynamic, time: number) =>
        followingSpeed(ghost, leadVehicle(ghost, [otherPose(lead.other, time)]))
    : null;
  const nearby = obstacles.filter(
    (o) =>
      dist(car, o) <
      (Math.max(Math.abs(car.speed), maxSpeed) +
        Math.abs(("speed" in o ? o.speed : 0) || 0)) *
        3 +
        Math.hypot(o.width || 1, o.depth || 1) / 2 +
        6,
  );
  const localRoute = car.route.points.slice(
    Math.max(0, near.index - 40),
    near.index + 180,
  );
  const mergeTraffic =
    merging &&
    nearby.some(
      (o) =>
        (o.type === "car" || o.type === "motorcycle") &&
        Math.cos(angle(o.heading - near.heading)) > 0 &&
        nearestOnPath(o, localRoute).distance < 8,
    );
  const guide = steeringForCurvature(
    (2 * Math.sin(angle(heading(car, goal) - car.heading))) /
      Math.max(4, dist(car, goal)),
    car.speed,
  );
  const limit = recovering
    ? 0.85
    : 0.85 * Math.min(1, 9 / Math.max(5, Math.abs(car.speed)));

  const laneHalfWidth =
    section?.laneHalfWidth ?? (world.type === "highway" ? 2.25 : 3);
  const laneMeasure = (pose: Pose) => {
    const n = nearestOnPath(pose, localRoute);
    const lateral =
      (pose.x - n.x) * Math.cos(n.heading) +
      (pose.z - n.z) * Math.sin(n.heading);
    const delta = angle(pose.heading - n.heading);
    const radius =
      (Math.abs(Math.cos(delta)) * car.width) / 2 +
      (Math.abs(Math.sin(delta)) * car.depth) / 2;
    return {
      offset: lateral,
      headingError: Math.abs(delta),
      excess: Math.max(
        0,
        Math.abs(lateral) +
          radius -
          (routeSection(car, n.s)?.laneHalfWidth ?? laneHalfWidth),
      ),
    };
  };
  const startLane = laneMeasure(car);

  function evaluate(
    steeringIn: number,
    velocityIn: number,
    laneOffset: number | null = null,
    lookahead: number | null = null,
    stopAtLine: StopAtLine | null = null,
  ): Evaluated {
    const maneuver: Maneuver & { steering: number } = {
      steering: steeringIn,
      lane_offset_m: laneOffset,
      lookahead_m: lookahead,
      stop_at_line: stopAtLine,
    };
    let steering = steeringIn;
    if (laneOffset !== null) steering = maneuverSteering(car, maneuver);
    steering = round(clamp(steering, -0.85, 0.85), 5);
    const velocity = round(velocityIn, 2);
    maneuver.steering = steering;
    const projection = projectVector(
      car,
      steering,
      velocity,
      maneuver,
      limitFollowingSpeed,
    );
    let outside = 0;
    let maxOutside = 0;
    let collision = false;
    let crossesStopLine = false;
    let collisionObject: string | null = null;
    let collisionTime: number | null = null;
    let firstOffroad: Candidate["first_offroad"] = null;
    const predictObstacles = createObstaclePrediction(car, nearby);
    const beforeStopLine = stopLine && stopLineDistance(car, stopLine) > 0;
    let previous: Car = { ...car };
    let laneError = 0;
    let laneExcess = 0;
    let maxHeadingError = 0;
    // Swept checks cover the gaps between samples; road coverage is the
    // area of the whole rotated body outside the road polygons.
    for (let i = 0; i < projection.points.length; i += 2) {
      const pose: Car = { ...car, ...projection.points[i] };
      if (beforeStopLine && stopLineDistance(pose, stopLine) <= 0)
        crossesStopLine = true;
      const status = roadOccupancy(pose, surfaces);
      if (!status.on_road && firstOffroad === null)
        firstOffroad = {
          in_s: round((i * VECTOR_HORIZON) / VECTOR_STEPS, 2),
          center: relativePoint(car, pose, 2),
        };
      const lane = laneMeasure(pose);
      laneError += Math.abs(lane.offset);
      laneExcess = Math.max(laneExcess, lane.excess);
      maxHeadingError = Math.max(maxHeadingError, lane.headingError);
      outside += status.outside_fraction;
      maxOutside = Math.max(maxOutside, status.outside_fraction);
      if (!collision && nearby.length) {
        const hit = firstCollision(
          previous,
          pose,
          predictObstacles(i * 0.05, pose),
        );
        collision = !!hit;
        collisionObject = hit?.object.id ?? null;
        if (hit)
          collisionTime =
            Math.max(0, (i - 2) * 0.05) + hit.fraction * (i ? 0.1 : 0);
      }
      previous = pose;
    }
    const end: Car = { ...car, ...last(projection.points) };
    const routeEnd = nearestOnPath(end, localRoute);
    const routeSoon = nearestOnPath(projection.evaluation, localRoute);
    const headingError =
      (Math.abs(angle(routeEnd.heading - end.heading)) * 180) / Math.PI;
    const tracking =
      routeSoon.distance +
      Math.abs(angle(routeSoon.heading - projection.evaluation.heading)) * 3;
    const imminentCollision =
      collisionTime !== null &&
      collisionTime <= Math.max(0.75, Math.abs(car.speed) / BRAKING + 0.3);
    const endLane = laneMeasure(end);
    const data: Candidate = {
      steering,
      velocity_mps: velocity,
      stop_at_line: stopAtLine,
      lane_offset_m: laneOffset,
      lookahead_m: lookahead,
      queue_compatible: laneOffset !== null && Math.abs(laneOffset) <= 0.2,
      following_vehicle_id: lead?.other.id ?? null,
      end_speed_mps: round(end.speed, 2),
      stop_line_after_m: stopLine
        ? round(stopLineDistance(end, stopLine), 1)
        : null,
      crosses_stop_line: crossesStopLine,
      stopping_distance_after_m: round(end.speed ** 2 / (2 * BRAKING), 1),
      lane_error_m: round(laneError / 31),
      lane_error_after_m: round(Math.abs(endLane.offset)),
      stays_in_lane: laneExcess < 0.12,
      returning_to_lane:
        laneExcess <= startLane.excess + 0.15 &&
        Math.abs(endLane.offset) < Math.abs(startLane.offset),
      route_error_m: round(tracking),
      route_progress_m: round(routeEnd.s - near.s, 1),
      follows_route_direction:
        velocity >= 0 &&
        maxHeadingError < Math.PI / 2 &&
        routeEnd.s >= near.s - 0.1,
      heading_error_deg: round(headingError, 1),
      offroad_fraction: round(outside / 31, 3),
      max_offroad_fraction: round(maxOutside, 6),
      stays_on_road: maxOutside < 1e-5,
      first_offroad: firstOffroad,
      end_position: relativePoint(car, end, 2),
      on_road_after: roadOccupancy(end, surfaces).on_road,
      road_distance_after_m: round(distanceToRoad(end, surfaces), 1),
      recovery_distance_m:
        recovering && recovery ? round(dist(end, goal), 1) : null,
      collision_predicted: collision,
      collision_imminent: imminentCollision,
      collision_in_s: collisionTime === null ? null : round(collisionTime, 2),
      collision_object_id: collisionObject,
    };
    const score =
      Number(imminentCollision) * 10000 +
      (collision && !imminentCollision ? 20 : 0) +
      (recovering
        ? (recovery ? dist(end, goal) : 100) +
          headingError * 0.035 +
          data.road_distance_after_m * 0.5
        : maxOutside * 1000 +
          laneExcess * 30 +
          (laneError / 31) * 8 +
          tracking +
          routeEnd.distance * 2 +
          Math.abs(steering - (car.wheelSteering ?? (car.steering as number))) *
            0.3);
    return { data, projection, score };
  }

  let pool: Evaluated[] = [];
  const count = recovering ? CANDIDATE_COUNT - 1 : 55;
  for (let i = 0; i < count; i++) {
    // Recovery draws stratified steering over the whole range; on the road,
    // broad draws mixed with jitter around route-following curvature.
    const steering = recovering
      ? -limit + 2 * limit * ((i + random()) / count)
      : i % 3 === 0
        ? (random() * 2 - 1) * limit
        : clamp(
            guide + (random() * 2 - 1) * Math.max(0.015, limit * 0.25),
            -limit,
            limit,
          );
    const velocity =
      maxSpeed < 0.15
        ? 0
        : recovering
          ? (i % 2 ? -1 : 1) * maxSpeed * (0.6 + 0.4 * random())
          : requiresStop && i < 8
            ? maxSpeed * (0.9 + random() * 0.1)
            : mergeTraffic && i < 5
              ? maxSpeed * (0.3 + random() * 0.25)
              : maxSpeed *
                (((requiresStop || mergeTraffic) && i < 10) || (lead && i < 8)
                  ? 0.25 + random() * 0.3
                  : merging
                    ? 0.95 + random() * 0.05
                    : i % 5
                      ? 0.94 + random() * 0.06
                      : 0.78 + random() * 0.12);
    // Dense near-center offsets for straights, wider lane-keeping ones beyond.
    const laneOffset =
      recovering || i >= 44
        ? null
        : round((random() * 2 - 1) * (i < 14 ? 0.1 : i < 30 ? 0.65 : 1.35), 3);
    const lookahead = recovering
      ? null
      : round(
          clamp(
            3.5 + Math.max(car.speed, maxSpeed) * 0.36 + random() * 0.8,
            4,
            10,
          ),
          2,
        );
    const stopAtLine: StopAtLine | null =
      requiresStop && i < 8
        ? {
            x: line.x,
            z: line.z,
            heading: line.heading,
            node_id: (crossing as NonNullable<typeof crossing>).nodeId,
            clearance_m: 0.5,
            deceleration_mps2: round(4 + random() * 0.8, 2),
          }
        : null;
    pool.push(evaluate(steering, velocity, laneOffset, lookahead, stopAtLine));
  }
  const mergeConflict =
    mergeTraffic &&
    pool.some(
      (p) =>
        p.data.queue_compatible &&
        p.data.velocity_mps > maxSpeed * 0.7 &&
        p.data.collision_predicted,
    );
  if (
    merging &&
    !recovering &&
    !requiresStop &&
    !mergeConflict &&
    maxSpeed >= 0.15
  ) {
    // Nearby traffic alone is no reason to creep: keep the slower gap
    // choices only when a forward rollout actually conflicts.
    pool = pool.filter((p) => p.data.velocity_mps >= maxSpeed * 0.7);
  }
  let selected: Evaluated[];
  if (recovering) selected = pool;
  else {
    const safe = pool.filter(
      (p) =>
        p.data.stays_on_road &&
        !p.data.collision_imminent &&
        (world.type !== "highway" || p.data.follows_route_direction) &&
        (p.data.stays_in_lane || p.data.returning_to_lane),
    );
    const rank = (a: Evaluated, b: Evaluated) => a.score - b.score;
    const eligible = queue ? safe.filter((p) => p.data.queue_compatible) : safe;
    const ranked = [
      ...eligible.sort(rank),
      ...pool.filter((p) => !eligible.includes(p)).sort(rank),
    ];
    // Keep precise road-following choices and a visible spread of
    // alternatives; unsafe exploratory paths stay visible but ineligible.
    selected = [];
    // A clear ramp accelerates; slower merge options only help with traffic
    // to fit between.
    if (requiresStop || mergeConflict) {
      const approach = pool
        .slice(0, requiresStop ? 8 : 5)
        .filter((p) => eligible.includes(p) && p.data.velocity_mps > 0)
        .sort(rank)[0];
      if (approach) selected.push(approach);
      for (const [low, high] of [
        [0.7, Number.POSITIVE_INFINITY],
        [0.25, 0.7],
      ] as const) {
        if (selected.length === 3) break;
        const candidate = ranked.find(
          (p) =>
            eligible.includes(p) &&
            p.data.queue_compatible &&
            !p.data.stop_at_line &&
            p.data.velocity_mps > maxSpeed * low &&
            p.data.velocity_mps <= maxSpeed * high &&
            !selected.includes(p),
        );
        if (candidate) selected.push(candidate);
      }
    }
    for (const candidate of ranked) {
      if (selected.length === 3) break;
      if (!selected.includes(candidate)) selected.push(candidate);
    }
    const lateral = pool
      .filter((p) => !selected.includes(p) && p.data.lane_offset_m !== null)
      .sort(
        (a, b) =>
          (a.data.lane_offset_m as number) - (b.data.lane_offset_m as number),
      );
    for (let i = 0; i < 4; i++)
      selected.push(
        lateral[Math.floor((i * (lateral.length - 1)) / 3)] as Evaluated,
      );
    const exploratory = pool
      .filter((p) => p.data.lane_offset_m === null)
      .sort((a, b) => a.data.steering - b.data.steering);
    for (let i = 0; i < 4; i++)
      selected.push(
        exploratory[
          Math.floor((i * (exploratory.length - 1)) / 3)
        ] as Evaluated,
      );
  }
  selected.push(evaluate(car.steering || 0, 0, recovering ? null : 0, 4.5));
  const vectors: Record<string, Candidate> = {};
  const projections: Record<string, Projection> = {};
  selected.forEach((p, i) => {
    const id = `${batch}_${i === selected.length - 1 ? "stop" : `v${i}`}`;
    vectors[id] = p.data;
    projections[id] = p.projection;
  });
  // The road preview covers the whole accelerating rollout.
  const roadPreview = Math.max(
    40,
    Math.max(Math.abs(car.speed), maxSpeed) * VECTOR_HORIZON + 10,
  );
  const road = roadState(car, surfaces, roadPreview);
  return {
    batch_id: batch,
    origin: { x: car.x, z: car.z, heading: car.heading, depth: car.depth },
    vectors,
    projections,
    stopLine,
    speedCap: maxSpeed,
    stopApproach: requiresStop
      ? {
          stop_line_ahead_m: round(stopLineDistance(car, line), 1),
          approach_cap_mps: round(maxSpeed, 2),
        }
      : null,
    blockingObject: nearbyPathBlocker(car, nearby),
    queue,
    road,
    lane: {
      drive_on: "right",
      offset_m: round(startLane.offset),
      half_width_m: laneHalfWidth,
      centerline: road.boundary_samples
        .filter((sample) => sample.route_ahead_m >= 0)
        .map(({ center: [right_m, ahead_m] }) => ({ right_m, ahead_m })),
    },
    recovery: {
      active: recovering,
      blocked: recovering && !recovery,
      speed_cap_mps: recovering ? maxSpeed : null,
      target: recovery
        ? {
            ...relativePoint(car, recovery.waypoint),
            heading_relative_deg: round(
              (angle((recovery.goal.heading as number) - car.heading) * 180) /
                Math.PI,
              1,
            ),
          }
        : null,
    },
  };
}

/** Whether the next second of a recovery maneuver would hit something. */
export function recoveryBlocked(
  car: Car,
  steering: number,
  velocity: number,
  obstacles: Obstacle[],
): boolean {
  const path = projectVector(car, steering, velocity);
  const nearby = obstacles.filter(
    (o) =>
      dist(car, o) <
      Math.max(8, Math.abs(car.speed) * 2) +
        Math.hypot(o.width || 1, o.depth || 1) / 2,
  );
  if (!nearby.length) return false;
  for (let i = 2; i <= 20; i += 2) {
    const a: Car = { ...car, ...path.points[i - 2] };
    const b: Car = { ...car, ...path.points[i] };
    if (
      firstCollision(
        a,
        b,
        nearby.map((o) => ({
          object: o.type === "building" ? o : otherPose(o, i * 0.05),
          previous:
            o.type === "building"
              ? undefined
              : collisionPose(otherPose(o, (i - 2) * 0.05)),
        })),
      )
    )
      return true;
  }
  return false;
}
