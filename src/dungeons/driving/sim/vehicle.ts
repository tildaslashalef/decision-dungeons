// Vehicle dynamics and maneuver control: the kinematic bicycle model, the
// speed profiles that approach stop lines and U-turns, and the rollout of a
// maneuver over the planning horizon. Real cars and candidate projections
// share these functions, so a projection is what the car will do.

import {
  angle,
  clamp,
  dist,
  heading,
  move,
  nearestOnPath,
  type Point,
  pointAt,
} from "../world/geometry.ts";
import { routeSection } from "../world/world.ts";
import type { Car, Maneuver, StopAtLine } from "./types.ts";

export const CANDIDATE_COUNT = 12;
/** Seconds a candidate path is projected. */
export const VECTOR_HORIZON = 3;
export const VECTOR_STEPS = 60;
/** The step of the projection where route tracking is judged (1.2 s). */
export const EVALUATION_STEPS = 24;
export const ACCELERATION = 5;
export const BRAKING = 8;
export const WHEELBASE = 2.7;
/** Within this distance of a blocker or a required line, a full stop may be chosen. */
export const FULL_STOP_DISTANCE_M = 2.5;

/** A car as the dynamics read it. */
export type Dynamic = Pick<
  Car,
  | "x"
  | "z"
  | "heading"
  | "speed"
  | "depth"
  | "route"
  | "steering"
  | "wheelSteering"
  | "steeringProgress"
>;

/**
 * Signed distance from the front bumper to the stop line's plane; positive
 * before the line. An observation, never a braking command.
 */
export function stopLineDistance(
  car: Point & { heading: number; depth: number },
  line: Point & { heading: number },
): number {
  const front = move(car, car.heading, car.depth / 2);
  return (
    (line.x - front.x) * Math.sin(line.heading) -
    (line.z - front.z) * Math.cos(line.heading)
  );
}

/**
 * The fastest approach to a required stop that still leaves time for the
 * next decision to arrive. Caps moving candidates; stopping is the decider's.
 */
export function stopApproachSpeed(
  car: Point & { heading: number; depth: number },
  line: Point & { heading: number },
): number {
  const room = Math.max(0, stopLineDistance(car, line) - 0.5);
  const deceleration = 4.5;
  const responseAllowance = 0.45;
  return Math.max(
    0.6,
    Math.sqrt(
      (deceleration * responseAllowance) ** 2 + 2 * deceleration * room,
    ) -
      deceleration * responseAllowance,
  );
}

/** Full low-speed lock fits the 3 m U-turn arcs; the extra lock fades out by 8 m/s. */
function steeringAngleScale(speed: number): number {
  return 0.58 + 0.37 * (1 - clamp((Math.abs(speed) - 3) / 5, 0, 1));
}

export function steeringCurvature(steering: number, speed: number): number {
  return Math.tan(steering * steeringAngleScale(speed)) / WHEELBASE;
}

export function steeringForCurvature(curvature: number, speed: number): number {
  return clamp(
    Math.atan(WHEELBASE * curvature) / steeringAngleScale(speed),
    -0.85,
    0.85,
  );
}

function integratePose(car: Dynamic, steer: number, dt: number): void {
  if (Math.abs(car.speed) < 0.01) car.speed = 0;
  car.steering = steer;
  car.heading = angle(
    car.heading + car.speed * steeringCurvature(steer, car.speed) * dt,
  );
  car.x += Math.sin(car.heading) * car.speed * dt;
  car.z -= Math.cos(car.heading) * car.speed * dt;
}

/** Autopilot dynamics: approach `target` speed within the acceleration limits. */
export function physics(
  car: Dynamic,
  steer: number,
  target: number,
  dt: number,
): void {
  car.speed += clamp(target - car.speed, -BRAKING * dt, ACCELERATION * dt);
  const actual = car.wheelSteering ?? car.steering ?? 0;
  car.wheelSteering = actual + clamp(steer - actual, -1.8 * dt, 1.8 * dt);
  integratePose(car, car.wheelSteering, dt);
  car.steering = steer;
}

/**
 * Free-play dynamics with pedals. Rolling resistance, engine braking, and
 * drag slow a released accelerator; there is no target-speed lock.
 */
export function pedalPhysics(
  car: Dynamic,
  steerInput: number,
  throttleInput: number,
  brakeInput: number,
  dt: number,
): void {
  const throttle = clamp(throttleInput, -1, 1);
  const brake = clamp(brakeInput, 0, 1);
  const speed = Math.abs(car.speed);
  const resistance =
    0.18 + 0.0017 * speed * speed + (Math.abs(throttle) < 0.01 ? 0.32 : 0);
  const opposingPedal = throttle * car.speed < -0.01;
  const braking = brake * 11 + (opposingPedal ? Math.abs(throttle) * 8 : 0);
  if (brake || opposingPedal || !throttle) {
    car.speed =
      Math.sign(car.speed) * Math.max(0, speed - (resistance + braking) * dt);
  } else {
    const acceleration = throttle * (throttle < 0 ? 2.5 : 5);
    car.speed +=
      (acceleration - Math.sign(car.speed || throttle) * resistance) * dt;
    car.speed = clamp(car.speed, -3, 34);
  }
  // A virtual steering stick (full travel in 0.63 s) with a soft center:
  // taps are precise, a held key reaches a sharp turn.
  const steer = clamp(steerInput, -1, 1);
  const current = car.steeringProgress || 0;
  const reversing = steer * current < 0;
  const goal = reversing ? 0 : steer;
  const returning = reversing || Math.abs(goal) < Math.abs(current);
  const step = (returning ? 5 : 1.6) * dt;
  car.steeringProgress = current + clamp(goal - current, -step, step);
  const input = car.steeringProgress;
  const shaped = input * (0.2 + 0.8 * Math.abs(input));
  const speedLimit = Math.min(
    1,
    (0.72 * 1.4) / (1 + (Math.abs(car.speed) / 7) ** 1.4),
  );
  // Full lock while crawling, blending into the normal cap.
  const limit =
    1 + (speedLimit - 1) * clamp((Math.abs(car.speed) - 3) / 5, 0, 1);
  car.wheelSteering = shaped * limit;
  integratePose(car, car.wheelSteering, dt);
}

export interface UTurnApproach {
  distance_m: number;
  speed_limit_mps: number;
}

/**
 * A U-turn is a 3 m arc starting just before its stop-line station. The
 * approach speed follows the braking distance left, rather than imposing
 * the arc's 3 m/s tens of meters early.
 */
export function uTurnApproach(
  car: Pick<Car, "x" | "z" | "route">,
  progress: number | null = null,
): UTurnApproach | null {
  if (!car.route?.points?.length) return null;
  const s = progress ?? nearestOnPath(car, car.route.points).s;
  const turn = car.route.crossings.find(
    (c) =>
      Math.cos(c.exit - c.approach) < -0.99 && c.stopS - 0.5 + Math.PI * 3 > s,
  );
  if (!turn) return null;
  const distance = Math.max(0, turn.stopS - 0.5 - s);
  return {
    distance_m: distance,
    speed_limit_mps: Math.sqrt(3 ** 2 + 2 * 5 * Math.max(0, distance - 1.5)),
  };
}

/** The highway section's limit, ramping up along an on-ramp and down before a slower section. */
export function routeSpeedLimit(
  car: Pick<Car, "x" | "z" | "route">,
  progress: number | null = null,
): number {
  if (!car.route?.sections?.length) return Number.POSITIVE_INFINITY;
  const s = progress ?? nearestOnPath(car, car.route.points).s;
  const current = routeSection(car, s);
  if (!current) return Number.POSITIVE_INFINITY;
  let limit = current.speedLimit;
  if (current.kind === "onramp") {
    // Reach the merge at motorway speed; rollouts and the real car share this profile.
    const along = clamp(
      (s - current.startS) / (current.endS - current.startS),
      0,
      1,
    );
    const entrySpeed = Math.min(18, limit);
    limit = entrySpeed + (limit - entrySpeed) * along;
  }
  for (const section of car.route.sections) {
    if (section.startS <= s || section.speedLimit >= limit) continue;
    // Arrive at a slower section already at its speed.
    limit = Math.min(
      limit,
      Math.sqrt(
        section.speedLimit ** 2 + 8 * Math.max(0, section.startS - s - 3),
      ),
    );
  }
  return limit;
}

/** The speed a maneuver allows now: the route's limits, and a stop-at-line profile. */
export function maneuverVelocity(
  car: Dynamic,
  candidate: Maneuver | null | undefined,
  velocity: number,
): number {
  if (velocity <= 0 || !Number.isFinite(candidate?.lane_offset_m))
    return velocity;
  let target = Math.min(
    velocity,
    routeSpeedLimit(car),
    uTurnApproach(car)?.speed_limit_mps ?? Number.POSITIVE_INFINITY,
  );
  const line: StopAtLine | null | undefined = candidate?.stop_at_line;
  if (line) {
    const room = Math.max(0, stopLineDistance(car, line) - line.clearance_m);
    // Advance to the line and come to rest there; the proportional term
    // settles near the line instead of creeping forever.
    const cap = Math.min(
      Math.sqrt(2 * line.deceleration_mps2 * room),
      room * 2.5,
    );
    target = Math.min(target, cap < 0.05 ? 0 : cap);
  }
  return target;
}

/**
 * Steering that holds the maneuver's lane offset, aiming `lookahead_m`
 * along the route (shortened near a U-turn). Without an offset, the
 * maneuver's fixed steering.
 */
export function maneuverSteering(
  car: Dynamic,
  candidate: Maneuver | null | undefined,
): number {
  if (!Number.isFinite(candidate?.lane_offset_m) || !car.route?.points?.length)
    return candidate?.steering ?? car.steering ?? 0;
  const m = candidate as Maneuver;
  const near = nearestOnPath(car, car.route.points);
  const turn = uTurnApproach(car, near.s);
  const lookahead = turn
    ? Math.min(m.lookahead_m as number, Math.max(2.6, turn.distance_m))
    : (m.lookahead_m as number);
  const center = pointAt(car.route.points, near.s + lookahead);
  const tangent = center.heading ?? near.heading;
  const goal = move(center, tangent + Math.PI / 2, m.lane_offset_m as number);
  return steeringForCurvature(
    (2 * Math.sin(angle(heading(car, goal) - car.heading))) /
      Math.max(2, dist(car, goal)),
    car.speed,
  );
}

export interface ProjectedPoint extends Point {
  heading: number;
  speed: number;
}

export interface Projection {
  axis: number;
  velocity: number;
  points: ProjectedPoint[];
  /** The ghost car at EVALUATION_STEPS. */
  evaluation: Dynamic;
  endHeading: number;
}

/** Rolls a maneuver out over the horizon from the car's real state, braking and reverse included. */
export function projectVector(
  car: Dynamic,
  steering: number,
  velocity: number,
  candidate: Maneuver | null = null,
  speedLimit: ((ghost: Dynamic, time: number) => number) | null = null,
): Projection {
  const ghost: Dynamic = { ...car };
  const points: ProjectedPoint[] = [{ ...ghost } as ProjectedPoint];
  let evaluation: Dynamic = ghost;
  for (let i = 0; i < VECTOR_STEPS; i++) {
    physics(
      ghost,
      candidate ? maneuverSteering(ghost, candidate) : steering,
      Math.min(
        maneuverVelocity(ghost, candidate, velocity),
        speedLimit
          ? speedLimit(ghost, (i * VECTOR_HORIZON) / VECTOR_STEPS)
          : Number.POSITIVE_INFINITY,
      ),
      VECTOR_HORIZON / VECTOR_STEPS,
    );
    points.push({
      x: ghost.x,
      z: ghost.z,
      heading: ghost.heading,
      speed: ghost.speed,
    });
    if (i === EVALUATION_STEPS - 1) evaluation = { ...ghost };
  }
  return {
    axis: steering,
    velocity,
    points,
    evaluation,
    endHeading: ghost.heading,
  };
}
