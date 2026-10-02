// The moving things: the player's car, traffic, pedestrians, and the
// maneuvers a decider chooses between.

import type { Point, Pose } from "../world/geometry.ts";
import type { Building, Route } from "../world/types.ts";

/** A stop line a maneuver approaches and comes to rest before. */
export interface StopAtLine extends Pose {
  node_id: string;
  clearance_m: number;
  deceleration_mps2: number;
}

/**
 * How a car drives: hold a lateral offset from the route (looking
 * `lookahead_m` ahead), or, with no offset, a fixed steering angle.
 */
export interface Maneuver {
  steering?: number;
  lane_offset_m: number | null;
  lookahead_m: number | null;
  stop_at_line?: StopAtLine | null;
}

/** A stop sign or signal visit: when the car arrived and whether its stop counts. */
export interface StopRecord {
  arrived: number;
  served: boolean;
  stationarySince?: number | null;
  passed?: boolean;
}

export interface IntersectionMemory {
  key: string;
  nodeId: string;
  stopCount: number;
  stationarySince: number | null;
  currentStopRecorded: boolean;
  lastStop: {
    position: Point;
    progress: number;
    lineDistance: number;
    signal: string | null;
    confirmedAt?: number;
    duration?: number;
  } | null;
}

export interface Car extends Pose {
  id: string;
  type: "car" | "motorcycle";
  speed: number;
  /** Station along the route. */
  s: number;
  route: Route;
  stops: Record<string, StopRecord>;
  width: number;
  depth: number;
  color?: string;
  /** The steering command; the wheels follow at a limited rate. */
  steering?: number;
  wheelSteering?: number;
  /** Free play: the virtual steering stick, −1 to 1. */
  steeringProgress?: number;
  /** The commanded speed. */
  target?: number;
  appliedTarget?: number;
  maneuver?: Maneuver | null;
  amber?: { key: string; proceed: boolean } | null;
  waitingSince?: number | null;
  intersectionMemory?: IntersectionMemory | null;
}

export interface Pedestrian extends Point {
  id: string;
  type: "pedestrian";
  nodeId: string;
  heading?: number;
  progress: number;
  walkPath: { start: Point; heading: number; length: number };
  direction: number;
  /** Crosses the junction on the walk signal rather than walking the sidewalk. */
  crossing: boolean;
  walking: boolean;
  speed: number;
  width: number;
  depth: number;
  height: number;
}

export type Mover = Car | Pedestrian;
/** Anything a car can hit. */
export type Obstacle = Mover | Building;

export const isVehicle = (o: Obstacle): o is Car =>
  o.type === "car" || o.type === "motorcycle";
