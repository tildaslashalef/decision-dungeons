// Messages between the driving stage (main thread: render, HUD, HTTP) and
// its simulation worker (the run itself: planning, physics, rules). The
// worker owns the only run, so turn-based play stays exactly the headless
// run: same seed and answers, same states.

import type { Answers } from "../../../contract/answer.ts";
import type { Request } from "../../../contract/request.ts";
import type { Outcome } from "../../dungeon.ts";
import type { Selection } from "../decide/selection.ts";
import type { DecisionState } from "../decide/state.ts";
import type { Navigation } from "../sim/navigation.ts";
import type { DrivingPlan } from "../sim/plan.ts";
import type { Crash, SimEvent } from "../sim/simulation.ts";
import type { PathPoint } from "../world/geometry.ts";

export interface CarPose {
  id: string;
  type: "car" | "motorcycle";
  x: number;
  z: number;
  heading: number;
  speed: number;
}

export interface PlayerPose extends CarPose {
  steering: number;
  wheelSteering: number;
  target: number;
}

export interface WalkerPose {
  id: string;
  x: number;
  z: number;
  heading: number;
  walking: boolean;
  crossing: boolean;
}

/** The run at one simulated instant, as much as rendering and the HUD need. */
export interface Snapshot {
  t: number;
  distance: number;
  player: PlayerPose;
  traffic: CarPose[];
  pedestrians: WalkerPose[];
  crash: Crash | null;
  brakeReason: string | null;
  routeVersion: number;
  nav: Navigation;
  recovering: boolean;
  onRoad: boolean;
  outcome: Outcome;
  /** Newest first, as the simulation keeps them. */
  events: SimEvent[];
  /** Signal offsets the run has changed (the stop-line check holds its light). */
  offsets: Record<string, number>;
}

/** Facts about traffic that do not change between snapshots. */
export interface CarLook {
  id: string;
  type: "car" | "motorcycle";
  color: string;
}

export type ToWorker =
  | { type: "start"; seed: number; level: string }
  | { type: "observe" }
  | { type: "apply"; answers: Answers }
  | { type: "advance" }
  | { type: "realtime"; on: boolean }
  | { type: "perception" };

export type FromWorker =
  | {
      type: "started";
      snapshot: Snapshot;
      route: PathPoint[];
      looks: CarLook[];
    }
  | {
      type: "observed";
      request: Request;
      resolved: Answers;
      state: DecisionState;
      plan: DrivingPlan | null;
      snapshot: Snapshot;
    }
  | { type: "applied"; selection: Selection | null; snapshot: Snapshot }
  | { type: "advanced"; snapshots: Snapshot[] }
  | { type: "tick"; snapshot: Snapshot }
  | { type: "route"; version: number; route: PathPoint[] }
  | { type: "looks"; looks: CarLook[] }
  | { type: "perception"; data: unknown }
  | { type: "error"; message: string };
