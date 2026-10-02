// How cars read each other: who leads, who follows, how close to follow,
// where everyone will be in a few seconds, and the first predicted conflict
// on the path the car is driving.

import {
  angle,
  clamp,
  dist,
  heading,
  move,
  type Point,
  pointAt,
  round,
} from "../world/geometry.ts";
import {
  footprintClearance,
  type Placed,
  type Shape,
  type Sweep,
} from "./collisions.ts";
import type { Car, Obstacle, Pedestrian } from "./types.ts";
import {
  BRAKING,
  type Dynamic,
  FULL_STOP_DISTANCE_M,
  maneuverSteering,
  maneuverVelocity,
  physics,
} from "./vehicle.ts";

/** A body with a pose, as traffic reasoning reads it. */
export type Body = Placed & { heading?: number; speed?: number };

export interface RelativeTraffic {
  ahead_m: number;
  right_m: number;
  relative_position: "behind" | "ahead" | "alongside";
  heading_relative_deg: number;
  relative_velocity_ahead_mps: number;
}

export function relativeTrafficState(
  vehicle: Car,
  other: Body,
): RelativeTraffic {
  const dx = other.x - vehicle.x;
  const dz = other.z - vehicle.z;
  const ahead = dx * Math.sin(vehicle.heading) - dz * Math.cos(vehicle.heading);
  const right = dx * Math.cos(vehicle.heading) + dz * Math.sin(vehicle.heading);
  const relativeHeading = angle((other.heading || 0) - vehicle.heading);
  return {
    ahead_m: round(ahead, 1),
    right_m: round(right, 1),
    relative_position:
      ahead < -1 ? "behind" : ahead > 1 ? "ahead" : "alongside",
    heading_relative_deg: round((relativeHeading * 180) / Math.PI, 1),
    relative_velocity_ahead_mps: round(
      (other.speed || 0) * Math.cos(relativeHeading) - vehicle.speed,
      1,
    ),
  };
}

function rearFollower(vehicle: Car, other: Body): boolean {
  if (other.type !== "car" && other.type !== "motorcycle") return false;
  const relative = relativeTrafficState(vehicle, other);
  return (
    relative.ahead_m < -vehicle.depth / 2 &&
    Math.abs(relative.heading_relative_deg) < 45 &&
    Math.abs(relative.right_m) < (vehicle.width + other.width) / 2 + 0.5
  );
}

export interface RearPressure {
  vehicle_id: string;
  gap_m: number;
  closing_speed_mps: number;
  time_to_close_gap_s: number | null;
  urgency: "high" | "moderate";
  preferred_action: "increase_forward_gap";
}

/** The nearest same-lane follower within 45 m, if any. */
export function rearTrafficPressure(
  vehicle: Car,
  traffic: Car[],
): RearPressure | null {
  const followers = traffic
    .filter((other) => rearFollower(vehicle, other))
    .map((other) => {
      const relative = relativeTrafficState(vehicle, other);
      const delta = angle((other.heading || 0) - vehicle.heading);
      const halfLength =
        (Math.abs(Math.cos(delta)) * other.depth +
          Math.abs(Math.sin(delta)) * other.width) /
        2;
      const gap = Math.max(
        0,
        -relative.ahead_m - vehicle.depth / 2 - halfLength,
      );
      const closing = Math.max(0, relative.relative_velocity_ahead_mps);
      return { other, gap, closing };
    })
    .filter(({ gap }) => gap < 45)
    .sort((a, b) => a.gap - b.gap);
  const nearest = followers[0];
  if (!nearest) return null;
  const { other, gap, closing } = nearest;
  const timeToClose = closing > 0.1 ? gap / closing : null;
  return {
    vehicle_id: other.id,
    gap_m: round(gap, 1),
    closing_speed_mps: round(closing, 1),
    time_to_close_gap_s: timeToClose === null ? null : round(timeToClose, 1),
    urgency:
      gap < 8 || (timeToClose !== null && timeToClose < 4)
        ? "high"
        : "moderate",
    preferred_action: "increase_forward_gap",
  };
}

export interface Blocker {
  id: string;
  type: string;
  gap_m: number;
}

/**
 * What blocks the next 2.5 m of the car's own path, by stepping along it.
 * Something behind the car or beside the lane does not unlock a full stop.
 */
export function nearbyPathBlocker(
  vehicle: Car,
  obstacles: Obstacle[],
): Blocker | null {
  const nearby = obstacles
    .filter((o) => o.id !== vehicle.id)
    .map((o) => ({
      ...o,
      heading: o.type === "building" ? -(o.rotation || 0) : o.heading || 0,
    }))
    .filter((o) => footprintClearance(vehicle, o) <= FULL_STOP_DISTANCE_M);
  if (!nearby.length) return null;
  const direction = (vehicle.target as number) < 0 ? -1 : 1;
  const ghost: Car = { ...vehicle, speed: direction };
  const maneuver = vehicle.maneuver || { lane_offset_m: 0, lookahead_m: 4.5 };
  for (let step = 0; step <= FULL_STOP_DISTANCE_M * 10; step++) {
    const blocker = nearby.find((o) => footprintClearance(ghost, o) <= 0.01);
    if (blocker)
      return { id: blocker.id, type: blocker.type, gap_m: round(step / 10, 1) };
    physics(ghost, maneuverSteering(ghost, maneuver), direction, 0.1);
  }
  return null;
}

/** The bumper gap to keep behind `other`: wider for motorcycles, growing with speed. */
export function followingGap(
  vehicle: Dynamic,
  other: Body | undefined,
): number {
  const speed = Math.abs(vehicle.speed);
  return other?.type === "motorcycle"
    ? Math.min(3, 0.9 + speed * 0.15)
    : Math.min(2.5, 0.5 + speed * 0.12);
}

export interface Lead<O extends Body = Body> {
  other: O;
  /** Bumper-to-bumper gap, meters. */
  gap: number;
}

/**
 * The nearest vehicle ahead in the car's strip, moving the same way.
 * Oncoming and crossing traffic is the swept-path check's business.
 */
export function leadVehicle<O extends Body>(
  vehicle:
    | Pick<Car, "id" | "x" | "z" | "heading" | "speed" | "depth" | "width">
    | (Dynamic & Partial<Car>),
  traffic: O[],
): Lead<O> | null {
  let lead: Lead<O> | null = null;
  for (const other of traffic) {
    if (other.id === vehicle.id) continue;
    const dx = other.x - vehicle.x;
    const dz = other.z - vehicle.z;
    const forward =
      dx * Math.sin(vehicle.heading) - dz * Math.cos(vehicle.heading);
    const right =
      dx * Math.cos(vehicle.heading) + dz * Math.sin(vehicle.heading);
    const relative = (other.heading || 0) - vehicle.heading;
    if (Math.cos(relative) < 0.5) continue;
    const length =
      (Math.abs(Math.cos(relative)) * (other.depth || 4.2)) / 2 +
      (Math.abs(Math.sin(relative)) * (other.width || 1.9)) / 2;
    const width =
      (Math.abs(Math.cos(relative)) * (other.width || 1.9)) / 2 +
      (Math.abs(Math.sin(relative)) * (other.depth || 4.2)) / 2;
    const gap = forward - (vehicle.depth || 4.2) / 2 - length;
    const buffer =
      other.type === "motorcycle"
        ? 0.55
        : Math.min(0.45, 0.18 + Math.abs(vehicle.speed) * 0.025);
    if (
      forward > 0 &&
      Math.abs(right) < (vehicle.width || 1.9) / 2 + width + buffer &&
      (!lead || gap < lead.gap)
    )
      lead = { other, gap };
  }
  return lead;
}

/** The speed that can still stop within `distance` at 5 m/s² after 0.35 s. */
export function brakingSpeed(distance: number): number {
  const deceleration = 5;
  const reaction = 0.35;
  return Math.max(
    0,
    Math.sqrt(
      (deceleration * reaction) ** 2 + 2 * deceleration * Math.max(0, distance),
    ) -
      deceleration * reaction,
  );
}

/**
 * The speed allowed behind a lead, re-evaluated as the gap closes: a moving
 * lead adds its own stopping distance; a stopped one allows a gentle creep.
 */
export function followingSpeed(vehicle: Dynamic, lead: Lead | null): number {
  if (!lead) return Number.POSITIVE_INFINITY;
  const speed = Math.max(
    0,
    (lead.other.speed || 0) *
      Math.cos((lead.other.heading || 0) - vehicle.heading),
  );
  const room = lead.gap - followingGap(vehicle, lead.other);
  return Math.min(
    brakingSpeed(room + (speed * speed) / 10),
    Math.max(0, speed + room * 1.5),
  );
}

/** Where a mover will be after `time` seconds at its current speed. */
export function otherPose<O extends Body>(other: O, time: number): O {
  // Movers differ in what predicts them: a walk, a route, or a heading.
  const o = other as Body & { route?: Car["route"]; s?: number };
  if (o.type === "pedestrian") {
    const walker = other as unknown as Pedestrian;
    if (walker.crossing) {
      const remaining = Math.max(0, 16 - (walker.progress || 0));
      const travel = Math.min(remaining, (walker.speed || 0) * time);
      return {
        ...other,
        ...move(walker, walker.heading || 0, travel),
        speed: travel >= remaining ? 0 : walker.speed,
      };
    }
    if (walker.walkPath?.length) {
      const { start, heading: pathHeading, length } = walker.walkPath;
      const progress = walker.progress + walker.direction * walker.speed * time;
      const wrapped = ((progress % (2 * length)) + 2 * length) % (2 * length);
      const forward = wrapped < length;
      return {
        ...other,
        ...move(start, pathHeading, forward ? wrapped : 2 * length - wrapped),
        heading: angle(
          pathHeading +
            ((forward ? walker.direction : -walker.direction) < 0
              ? Math.PI
              : 0),
        ),
      };
    }
  }
  if (o.route?.points?.length && Number.isFinite(o.s)) {
    const car = other as unknown as Car;
    const travel = Math.max(0, car.speed) * time;
    const s = car.s + travel;
    // Traffic drives on past its route's end while leaving the view; predict
    // from where it really is rather than clamping to the endpoint.
    if (car.s >= car.route.length - 1)
      return { ...other, ...move(car, car.heading, travel), s };
    const p = pointAt(car.route.points, s);
    const before = pointAt(
      car.route.points,
      Math.max(0, Math.min(s, car.route.length) - 0.2),
    );
    const h = heading(before, p);
    return {
      ...other,
      ...move(p, h, Math.max(0, s - car.route.length)),
      heading: h,
      s,
    };
  }
  return {
    ...other,
    x: other.x + Math.sin(other.heading || 0) * (other.speed || 0) * time,
    z: other.z - Math.cos(other.heading || 0) * (other.speed || 0) * time,
  };
}

export type Prediction = (
  time: number,
  ego: Dynamic & Partial<Car>,
) => Sweep<Body>[];

/**
 * Predicted obstacle poses over time. Rear traffic follows the ego car with
 * the same gap control and braking as NPCs; extrapolating it at constant
 * speed would invent rear-end crashes whenever the car waits.
 * Calls must come in increasing `time`.
 */
export function createObstaclePrediction(
  vehicle: Car,
  obstacles: Obstacle[],
): Prediction {
  const followers = new Set(
    obstacles.filter((o) => rearFollower(vehicle, o)).map((o) => o.id),
  );
  let previous = new Map<string, Body>(obstacles.map((o) => [o.id, o]));
  let lastTime = 0;
  let previousEgo: Body = vehicle;
  return (time, ego) => {
    const dt = Math.max(0, time - lastTime);
    const traffic = [
      previousEgo,
      ...[...previous.values()].filter(
        (o) => o.type === "car" || o.type === "motorcycle",
      ),
    ];
    const samples: Sweep<Body>[] = obstacles.map((original) => {
      if (original.type === "building") return { object: original };
      const prior = previous.get(original.id) as Body & Dynamic;
      let pose: Body;
      if (followers.has(original.id)) {
        const target = Math.min(
          Math.max(original.speed || 0, ego.speed),
          followingSpeed(prior, leadVehicle(prior, traffic)),
        );
        const speed = Math.max(
          0,
          prior.speed + clamp(target - prior.speed, -7 * dt, 2.8 * dt),
        );
        pose = otherPose({ ...prior, speed }, dt);
      } else pose = otherPose(original as Body, time);
      // The prior is a whole body; the sweep reads its pose fields.
      return { object: pose, previous: prior as unknown as Shape };
    });
    previous = new Map(samples.map(({ object }) => [object.id, object]));
    lastTime = time;
    previousEgo = { ...ego } as Body;
    return samples;
  };
}

export interface Conflict extends RelativeTraffic {
  object_id: string;
  type: string;
  time_s: number;
  distance_along_path_m: number;
  braking_reduces_risk: boolean;
  max_speed_mps: number | null;
  reason: string;
}

/**
 * The first predicted conflict on the car's current maneuver over 3–5 s,
 * motorcycles outside the lane strip included. It only limits speed; the
 * decider steers. A same-lane follower closing from behind is reported
 * last, since braking cannot resolve it.
 */
export function predictTrafficConflict(
  vehicle: Car,
  obstacles: Mover[],
): Conflict | null {
  const target = Math.max(0, vehicle.speed, vehicle.target || 0);
  const horizon = clamp(target / BRAKING + 1, 3, 5);
  const step = 0.1;
  const nearby = obstacles.filter(
    (o) =>
      o.id !== vehicle.id &&
      dist(vehicle, o) < (target + Math.abs(o.speed || 0)) * horizon + 12,
  );
  if (!nearby.length) return null;
  const ghost: Car = { ...vehicle };
  const prediction = createObstaclePrediction(vehicle, nearby);
  const originals = new Map<string, Body>(nearby.map((o) => [o.id, o]));
  const lead = leadVehicle(
    vehicle,
    nearby.filter((o): o is Car => o.type === "car" || o.type === "motorcycle"),
  );
  let traveled = 0;
  let rearThreat: Conflict | null = null;
  for (let time = 0; time <= horizon; time += step) {
    if (time > 0) {
      const steering = vehicle.maneuver
        ? maneuverSteering(ghost, vehicle.maneuver)
        : vehicle.steering || 0;
      const ahead = lead
        ? leadVehicle(ghost, [otherPose(lead.other, time - step)])
        : null;
      const before: Point = { x: ghost.x, z: ghost.z };
      physics(
        ghost,
        steering,
        Math.min(
          maneuverVelocity(ghost, vehicle.maneuver, target),
          followingSpeed(ghost, ahead),
        ),
        step,
      );
      traveled += dist(before, ghost);
    }
    for (const { object: pose } of prediction(time, ghost)) {
      const other = originals.get(pose.id) as Body;
      // Cover the motion between samples, with extra room around a rider.
      const buffer =
        (other.type === "motorcycle"
          ? 0.3
          : other.type === "pedestrian"
            ? 0.35
            : 0.12) +
        Math.min(0.8, ((ghost.speed + Math.abs(pose.speed || 0)) * step) / 2);
      if (footprintClearance(ghost, pose) > buffer) continue;
      const fromBehind =
        rearFollower(vehicle, other) &&
        ghost.speed >= 0 &&
        Math.cos(ghost.heading - vehicle.heading) > 0.85 &&
        Math.cos((pose.heading as number) - ghost.heading) > 0.5;
      const conflict: Conflict = {
        object_id: other.id,
        type: other.type,
        ...relativeTrafficState(vehicle, other),
        time_s: time,
        distance_along_path_m: traveled,
        braking_reduces_risk: !fromBehind,
        max_speed_mps: fromBehind
          ? null
          : brakingSpeed(traveled - (other.type === "pedestrian" ? 0.65 : 0.3)),
        reason: fromBehind
          ? "Following traffic behind"
          : other.type === "motorcycle"
            ? "Motorcycle clearance"
            : other.type === "pedestrian"
              ? "Pedestrian clearance"
              : "Crossing or merging traffic",
      };
      if (fromBehind) rearThreat ??= conflict;
      else return conflict;
    }
  }
  return rearThreat;
}

type Mover = Car | Pedestrian;
