// The full decision state at one moment: the candidates of a fresh plan
// and everything about the car's situation a decider is given. The request
// (request.ts) is a compact projection of it; the inspector shows it whole.

import {
  type GlobalNavigation,
  globalNavigation,
  navigation,
  type Turn,
} from "../sim/navigation.ts";
import type { Seen } from "../sim/perception.ts";
import { scanScene } from "../sim/perception.ts";
import {
  type Candidate,
  createDrivingPlan,
  type DrivingPlan,
  type Queue,
} from "../sim/plan.ts";
import {
  crossingFor,
  intersectionStopMemory,
  PLAYER_STOP_DWELL_S,
  type StopMemory,
  speedEnvelope,
} from "../sim/rules.ts";
import type { Simulation } from "../sim/simulation.ts";
import {
  type Blocker,
  followingGap,
  type RearPressure,
  rearTrafficPressure,
} from "../sim/traffic.ts";
import { BRAKING, stopLineDistance, uTurnApproach } from "../sim/vehicle.ts";
import { round } from "../world/geometry.ts";
import type { RoadState } from "../world/road.ts";
import type { Junction } from "../world/types.ts";
import {
  candidateChoices,
  type StopAvailability,
  stopAvailability,
} from "./selection.ts";

export interface DecisionState {
  batch_id: string;
  route_version: number;
  global: GlobalNavigation;
  driving_style: { name: string; description: string; rules: string[] };
  speed_mps: number;
  braking: {
    max_deceleration_mps2: number;
    stopping_distance_m: number;
    comfortable_stopping_distance_m: number;
    decision_allowance_m: number;
  };
  limit_mps: number;
  speed_ceiling_mps: number;
  speed_constraints: {
    traffic_and_destination_cap_mps: number;
    required_stop_approach: DrivingPlan["stopApproach"];
    uturn_approach: {
      curve_ahead_m: number;
      approach_cap_mps: number;
      curve_speed_mps: number;
    } | null;
  };
  road: RoadState | Omit<RoadState, "drivable_polygons">;
  lane: DrivingPlan["lane"];
  traffic: {
    queue: Queue | null;
    rear_pressure: RearPressure | null;
    stopped_for_s: number;
    deadlock_release: boolean;
  };
  recovery: DrivingPlan["recovery"];
  bend_deg: number;
  destination_m: number;
  turn: { direction: Turn; in_m: number };
  trip?: { phase: string; instruction: string; road: string };
  scene: {
    blocking_object: Blocker | null;
    observed_at_s: number;
    coordinates: string;
    traffic_view_deg: number;
    range_m: number;
    intersection: {
      node_id: string;
      control: string;
      signal: string | null;
      visible: boolean;
      stop_line_ahead_m: number;
      stop_line_position: { x: number; z: number };
      already_entered: boolean;
      stop_completed: boolean;
      stop_dwell_s: number;
      stop_memory: StopMemory | null;
      earlier_arrivals: string[];
    } | null;
    nearby: Seen[];
    following?: { id: string; gap_m: number; minimum_gap_m: number };
    hazard?: {
      id: string;
      type: string;
      applies_to: "current_maneuver";
      in_s: number;
      ahead_m: number;
      right_m: number;
      relative_position: string;
      distance_along_path_m: number;
      braking_reduces_risk: boolean;
    };
  };
  vectors: Record<string, Candidate>;
  stop_availability?: StopAvailability;
}

const DRIVING_STYLE = {
  name: "aggressive",
  description:
    "An aggressive, decisive driver who actively wants to make forward progress. Prefer the fastest useful maneuver and take available gaps promptly. Slowing down still means driving; a full stop needs a concrete current reason.",
  rules: [
    "A full-stop choice is offered only within 2.5 meters of a blocking object or a required stop line, at the destination, or when no eligible moving path exists. Otherwise choose a moving vector, reducing speed as needed. Uncertainty alone is not a reason to stop.",
    "When stopping behind a blocking object, close to within 2 meters bumper-to-object before coming to rest when space permits. Slow earlier as needed; do not park several car lengths back. An imminent collision can require braking sooner.",
    "For stop signs and red lights, stop right at the line with the front bumper about 0.5 meters before it, not farther back. A distant red light or stop sign is a reason to approach, not to stop immediately.",
    "Use a stop_at_line moving vector to approach an unserved stop sign or red light. It carries speed toward the line and then stops there; do not wait until 2.5 meters away to begin slowing. Once the stop is served or the light is green, choose a continuing path when clear.",
    "Remember a completed stop on this approach. Advance after an early stop, and proceed once the required stop is complete and the actual path is clear. Do not repeatedly stop for the same sign.",
    "At green lights or after a completed stop, move decisively through the junction. Yield only to actual conflicting priority traffic. Do not wait for the whole intersection to become empty.",
    "Accelerate along a clear on-ramp, match interstate traffic speed while merging, then accelerate to the cruising limit. A ramp-to-merge boundary is a continuous road, not a stop or a U-turn. Slow to fit behind another vehicle only when there is an actual merging conflict.",
    "A close or closing follower behind should motivate faster forward progress when the road ahead allows it. Traffic behind, alongside, or in the opposite lane is not itself a reason to brake.",
    "Stay in the right-hand lane, follow a normal traffic queue without passing, and use current signal and collision information. Later hypothetical conflicts are warnings to reassess, not immediate stop commands.",
  ],
};

const MOVERS = new Set(["car", "motorcycle", "pedestrian"]);

/** Plans a fresh batch of candidates and assembles the decision state around it. */
export function decisionState(sim: Simulation): DecisionState {
  // Decide on a fresh scan, not the last sensor tick.
  scanScene(sim);
  const nav = navigation(sim);
  const env = speedEnvelope(sim, sim.player);
  const observed = new Set(sim.perception.map((o) => o.id));
  const rearPressure = rearTrafficPressure(
    sim.player,
    sim.traffic.filter((o) => observed.has(o.id)),
  );
  const priority = (o: Seen) =>
    Number(
      o.id === env.conflict?.object_id ||
        o.id === env.lead?.other.id ||
        o.id === rearPressure?.vehicle_id,
    );
  const dynamic = sim.perception
    .filter((o) => MOVERS.has(o.type))
    .sort((a, b) => priority(b) - priority(a))
    .slice(0, 10);
  const control = crossingFor(sim.player);
  const seenControl =
    control &&
    sim.perception.some((o) => {
      const object = sim.world.objects.find((w) => w.id === o.id);
      return !!object && "nodeId" in object && object.nodeId === control.nodeId;
    });
  const uTurn = uTurnApproach(sim.player);
  // Highway ramps have continuous section speed profiles; the city-junction
  // heuristic would take a sweeping ramp for a sharp turn.
  const turning = nav.next_turn === "left" || nav.next_turn === "right";
  const turnCap = nav.phase
    ? Number.POSITIVE_INFINITY
    : Math.abs(nav.heading_error_deg) > 15 ||
        (turning && nav.turn_distance_m < 24)
      ? nav.next_turn === "right"
        ? 7
        : 8
      : turning && nav.turn_distance_m < 48
        ? 12
        : sim.world.theme.limit;
  const ceiling = round(
    Math.min(
      env.planningMax,
      uTurn?.speed_limit_mps ?? Number.POSITIVE_INFINITY,
      turnCap,
    ),
    1,
  );
  const plan = createDrivingPlan(
    sim.player,
    sim.world,
    [...sim.buildings, ...sim.traffic, ...sim.pedestrians],
    sim.planRandom,
    `b${++sim.planSequence}`,
    ceiling,
    env.rule,
  );
  sim.lastPlan = plan;
  // Readable edges in normal driving; the raw road polygons only in recovery.
  const { drivable_polygons: _, ...roadSummary } = plan.road;
  const stopLine = plan.stopLine;
  const player = sim.player;
  const state: DecisionState = {
    batch_id: plan.batch_id,
    route_version: sim.routeVersion,
    global: globalNavigation(sim),
    driving_style: DRIVING_STYLE,
    speed_mps: round(player.speed, 1),
    braking: {
      max_deceleration_mps2: BRAKING,
      stopping_distance_m: round(player.speed ** 2 / (2 * BRAKING), 1),
      comfortable_stopping_distance_m: round(player.speed ** 2 / 7, 1),
      decision_allowance_m: round(Math.abs(player.speed) * 0.35, 1),
    },
    limit_mps: nav.speed_limit_mps ?? sim.world.theme.limit,
    speed_ceiling_mps: plan.speedCap,
    speed_constraints: {
      traffic_and_destination_cap_mps: round(env.planningMax, 1),
      required_stop_approach: plan.stopApproach,
      uturn_approach: uTurn
        ? {
            curve_ahead_m: round(uTurn.distance_m, 1),
            approach_cap_mps: round(uTurn.speed_limit_mps, 1),
            curve_speed_mps: 3,
          }
        : null,
    },
    road: plan.recovery.active ? plan.road : roadSummary,
    lane: plan.lane,
    traffic: {
      queue: plan.queue,
      rear_pressure: rearPressure,
      stopped_for_s: round(
        player.waitingSince === null || player.waitingSince === undefined
          ? 0
          : sim.time - player.waitingSince,
        1,
      ),
      deadlock_release: env.released,
    },
    recovery: plan.recovery,
    bend_deg: round(Math.abs(nav.heading_error_deg), 1),
    destination_m: round(nav.remaining_m, 1),
    turn: { direction: nav.next_turn, in_m: round(nav.turn_distance_m, 1) },
    ...(nav.phase
      ? {
          trip: {
            phase: nav.phase,
            instruction: nav.instruction as string,
            road: nav.road_name as string,
          },
        }
      : {}),
    scene: {
      blocking_object: plan.blockingObject,
      observed_at_s: round(sim.time, 2),
      coordinates:
        "Car-relative meters: ahead_m is positive ahead and negative behind; right_m is positive to the right. heading_relative_deg=0 is the same direction, 180 is oncoming. Positive relative_velocity_ahead_mps means moving forward relative to this car.",
      traffic_view_deg: 360,
      range_m: Math.round(sim.sensorRange),
      intersection:
        control && stopLine
          ? {
              node_id: control.nodeId,
              control: (sim.world.byId[control.nodeId] as Junction).control,
              signal: seenControl ? env.rule.color : null,
              visible: !!seenControl,
              stop_line_ahead_m: round(stopLineDistance(player, stopLine), 1),
              stop_line_position: {
                x: round(stopLine.x, 1),
                z: round(stopLine.z, 1),
              },
              already_entered: env.rule.distance < -0.7,
              stop_completed: env.rule.stopCompleted as boolean,
              stop_dwell_s: PLAYER_STOP_DWELL_S,
              stop_memory: intersectionStopMemory(sim, control),
              earlier_arrivals: sim.traffic
                .filter((other) => {
                  const stopped = other.stops[control.nodeId];
                  return (
                    !!stopped &&
                    !stopped.passed &&
                    crossingFor(other)?.nodeId === control.nodeId &&
                    stopped.arrived <
                      (player.stops[control.nodeId]?.arrived ??
                        Number.POSITIVE_INFINITY)
                  );
                })
                .map((other) => other.id),
            }
          : null,
      nearby: dynamic,
      ...(env.lead && env.gap < sim.sensorRange
        ? {
            following: {
              id: env.lead.other.id,
              gap_m: round(env.gap, 1),
              minimum_gap_m: round(followingGap(player, env.lead.other), 1),
            },
          }
        : {}),
      ...(env.conflict
        ? {
            hazard: {
              id: env.conflict.object_id,
              type: env.conflict.type,
              applies_to: "current_maneuver" as const,
              in_s: round(env.conflict.time_s, 1),
              ahead_m: env.conflict.ahead_m,
              right_m: env.conflict.right_m,
              relative_position: env.conflict.relative_position,
              distance_along_path_m: round(
                env.conflict.distance_along_path_m,
                1,
              ),
              braking_reduces_risk: env.conflict.braking_reduces_risk,
            },
          }
        : {}),
    },
    vectors: plan.vectors,
  };
  state.stop_availability = stopAvailability(state);
  if (!state.stop_availability.available) {
    state.vectors = Object.fromEntries(
      Object.entries(state.vectors).filter(
        ([, vector]) => vector.velocity_mps !== 0,
      ),
    );
    plan.vectors = state.vectors;
    for (const id of Object.keys(plan.projections))
      if (!Object.hasOwn(state.vectors, id)) delete plan.projections[id];
  }
  plan.eligible = candidateChoices(state);
  sim.lastDecisionState = state;
  return state;
}
