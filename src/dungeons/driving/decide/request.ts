// The driving state as a decision request: Jev's request (compact tables
// of candidate paths, road edges, traffic; instructions only for the
// situations at hand), with each path's facts also written into its option
// text and situational instructions first, so a model that reads 512
// tokens sees what it is choosing between. Every decider gets this same
// request, so comparisons stay on equal input.
// Questions with a single option are answered here, not asked.

import type { Answers, ChoiceAnswer } from "../../../contract/answer.ts";
import type { JsonValue, Request } from "../../../contract/request.ts";
import type { Candidate } from "../sim/plan.ts";
import { decisionOptions } from "./selection.ts";
import type { DecisionState } from "./state.ts";

type Row = (number | boolean | string | null)[];

export interface Table {
  columns: string[];
  rows: Record<string, Row> | Row[];
  shared?: Record<string, number | boolean | string | null>;
}

const rounded = (value: number | null | undefined): number | null =>
  Number.isFinite(value) ? Math.round((value as number) * 10) / 10 : null;
const point = (
  p: [number, number] | null | undefined,
): [number | null, number | null] =>
  p ? [rounded(p[0]), rounded(p[1])] : [null, null];

/**
 * Factors out columns whose value every row shares, losslessly; tables of
 * fewer than three rows stay as they are.
 */
export function table(
  columnsIn: string[] | string,
  rows: Record<string, Row> | Row[],
): Table {
  const columns =
    typeof columnsIn === "string" ? columnsIn.split(",") : columnsIn;
  const values = Object.values(rows) as Row[];
  if (values.length < 3) return { columns, rows };
  const shared: Record<string, Row[number]> = {};
  const varying: number[] = [];
  const first = values[0] as Row;
  columns.forEach((column, i) => {
    const value = first[i] ?? null;
    if (values.every((row) => Object.is(row[i] ?? null, value)))
      shared[column] = value;
    else varying.push(i);
  });
  if (!Object.keys(shared).length) return { columns, rows };
  const project = (row: Row): Row => varying.map((i) => row[i] ?? null);
  return {
    shared,
    columns: varying.map((i) => columns[i] as string),
    rows: Array.isArray(rows)
      ? rows.map(project)
      : Object.fromEntries(
          Object.entries(rows).map(([id, row]) => [id, project(row)]),
        ),
  };
}

/** Straight edges keep their endpoints; bends and width changes keep ≤ 10 cm deviation. */
function boundaryRows(
  samples: DecisionState["road"]["boundary_samples"],
): Row[] {
  const rows: (number | null)[][] = samples.map((p) => [
    rounded(p.route_ahead_m),
    ...point(p.center),
    ...point(p.road_left),
    ...point(p.road_right),
  ]);
  const keep = new Set([0, rows.length - 1]);
  const pending: [number, number][] =
    rows.length > 2 ? [[0, rows.length - 1]] : [];
  while (pending.length) {
    const [a, b] = pending.pop() as [number, number];
    let worst = 0.1;
    let index = -1;
    const ra = rows[a] as (number | null)[];
    const rb = rows[b] as (number | null)[];
    for (let i = a + 1; i < b; i++) {
      const ri = rows[i] as (number | null)[];
      const t =
        ((ri[0] as number) - (ra[0] as number)) /
        ((rb[0] as number) - (ra[0] as number));
      for (let k = 1; k < 7; k++) {
        const triple = [ra[k], ri[k], rb[k]];
        const error = triple.every((v) => v === null)
          ? 0
          : triple.some((v) => v === null)
            ? Number.POSITIVE_INFINITY
            : Math.abs(
                (ri[k] as number) -
                  ((ra[k] as number) +
                    ((rb[k] as number) - (ra[k] as number)) * t),
              );
        if (error > worst) {
          worst = error;
          index = i;
        }
      }
    }
    if (index !== -1) {
      keep.add(index);
      pending.push([a, index], [index, b]);
    }
  }
  return rows.filter((_, i) => keep.has(i));
}

const singleAnswer = (
  criteria: Record<string, unknown>,
): ChoiceAnswer | null => {
  const ids = Object.keys(criteria);
  const only = ids[0];
  return ids.length === 1 && only !== undefined
    ? { type: "choice", choice: only, probabilities: { [only]: 1 } }
    : null;
};

export const VECTOR_GOAL =
  "Assuming drive, choose fastest useful progress with low route/lane error. Predictions include following and curve/section speed control. Keep the whole car on asphalt: negative clearance=off-road, null edges=unknown, preview end is not road end.";

const MOTION_INSTRUCTIONS =
  "Drive includes slowing or approaching a stop line; stop means zero target speed NOW. Prefer drive when useful progress is possible. Use current conflicts, legal requirements and stop memory; proximity alone is not a reason to stop.";

const MOTION_OPTIONS = {
  drive: "keep moving along the best path",
  stop: "brake to zero speed now",
};

/**
 * One candidate's row as a phrase, most decisive facts first (a long option
 * is cut at its tail); errors that round to zero are left out.
 */
function describeCandidate(
  values: Record<string, Row[number] | undefined>,
  conflict: { in_s: number | null } | undefined,
): string {
  const parts: string[] = [];
  if (conflict) parts.push(`collision in ${conflict.in_s}s`);
  if (values.stop_at_line) parts.push("stops at line");
  else if (values.crosses_line) parts.push("crosses line");
  if (values.on_road === false) parts.push("leaves road");
  if (values.in_lane === false)
    parts.push(values.returning_to_lane ? "returns to lane" : "leaves lane");
  if (values.on_road_after === false) parts.push("still off road");
  parts.push(
    values.end_speed === values.speed
      ? `speed ${values.speed}`
      : `speed ${values.speed} to ${values.end_speed}`,
  );
  parts.push(`progress ${values.progress}`);
  if (values.recovery_distance != null)
    parts.push(`recovery ${values.recovery_distance}`);
  if (values.route_error) parts.push(`off route ${values.route_error}`);
  if (values.lane_error) parts.push(`off lane ${values.lane_error}`);
  if (values.heading_error) parts.push(`heading ${values.heading_error}`);
  return parts.join(", ");
}

export interface PreparedRequest {
  request: Request;
  /** Answers to questions with one option, settled without asking. */
  fixed: Answers;
  /** Request path ids (v0, v1, …) to the plan's candidate ids. */
  aliases: Record<string, string>;
}

/**
 * The complete, stateless request for one decision: nothing it leaves out
 * depends on a decider remembering an earlier one.
 */
export function prepareRequest(full: DecisionState): PreparedRequest {
  const { moving, motion } = decisionOptions(full);
  const aliases = Object.fromEntries(
    Object.keys(moving).map((id, i) => [`v${i}`, id]),
  );
  const vectors: Record<string, Candidate> = Object.fromEntries(
    Object.entries(aliases).map(([id, original]) => [
      id,
      moving[original] as Candidate,
    ]),
  );
  const intersection = full.scene?.intersection;
  const recovery = full.recovery?.active;
  const nearby = full.scene?.nearby || [];
  const follower = full.traffic?.rear_pressure;
  const lead = full.traffic?.queue || full.scene?.following;
  const hazard = full.scene?.hazard;
  const hasTraffic =
    nearby.length || follower || lead || hazard || full.scene?.blocking_object;
  const requiredStop =
    !!full.speed_constraints?.required_stop_approach ||
    !!(
      intersection &&
      !intersection.already_entered &&
      ((intersection.control === "stop" && !intersection.stop_completed) ||
        (intersection.control === "signal" &&
          (intersection.signal === "red" || intersection.signal === "amber")))
    );
  const footprint = full.road.ego_footprint;
  const state: Record<string, JsonValue> = {
    driving_style: [
      "Aggressive right-lane driver: favor fast useful progress. Stop only for imminent collision, a required line, or arrival.",
      hasTraffic
        ? "Follow queues without passing; close to 2m before stopping. Rear/oncoming/adjacent traffic alone is no reason to brake."
        : "",
      intersection
        ? "Approach the line; stop 0.5m before it. Green or completed stop: proceed when your path is clear."
        : "",
    ]
      .filter(Boolean)
      .join(" "),
    units:
      "m,s,m/s,deg; points=[right,ahead], negative ahead=behind. Table shared values apply to every row." +
      (nearby.length ? " Traffic heading:0=same direction,180=oncoming." : ""),
    speed: rounded(full.speed_mps),
    limit: rounded(full.limit_mps),
  };
  const nav: Record<string, JsonValue> = {
    turn: full.turn.direction,
    in_m: rounded(full.turn.in_m),
    remaining_m: rounded(full.destination_m),
    ...(full.trip ? { phase: full.trip.phase } : {}),
  };
  state.nav = nav;
  const road: Record<string, JsonValue> = {
    on_road: full.road.on_road,
    lane_offset: rounded(full.lane.offset_m),
    lane_half_width: rounded(full.lane.half_width_m),
  };
  if (footprint?.length)
    road.body_width_length = [0, 1].map((axis) => {
      const coords = footprint.map((p) => p[axis] as number);
      return rounded(Math.max(...coords) - Math.min(...coords));
    });
  // Left and right are the asphalt's edges; lane edges follow from the
  // route center and half-width, so sending both would repeat every point.
  road.boundaries = table(
    "route_ahead,center_right,center_ahead,left_right,left_ahead,right_right,right_ahead",
    boundaryRows(full.road.boundary_samples || []),
  ) as unknown as JsonValue;
  road.body_edge_clearance_rear_center_front = (
    full.road.edge_clearance_samples || []
  ).map((p) => [rounded(p.left_clearance_m), rounded(p.right_clearance_m)]);
  state.road = road;
  const global = full.global;
  if (global?.position && global?.destination) {
    const h = (global.position.heading_deg * Math.PI) / 180;
    const dx = global.destination.x - global.position.x;
    const dz = global.destination.z - global.position.z;
    nav.destination = [
      rounded(dx * Math.cos(h) + dz * Math.sin(h)),
      rounded(dx * Math.sin(h) - dz * Math.cos(h)),
    ];
  }
  if (intersection) {
    const memory = intersection.stop_memory;
    state.intersection = {
      control: intersection.control,
      signal: intersection.signal,
      bumper_to_line: rounded(intersection.stop_line_ahead_m),
      entered: intersection.already_entered,
      stop_completed: intersection.stop_completed,
      ...(intersection.earlier_arrivals?.length
        ? { earlier_arrivals: intersection.earlier_arrivals.length }
        : {}),
      ...(memory
        ? {
            stops: memory.stops_on_this_approach,
            dwell: memory.current_stop_duration_s,
            ...(memory.last_stop
              ? {
                  last_stop: {
                    age: memory.last_stop.age_s,
                    duration: memory.last_stop.duration_s,
                    bumper_to_line: memory.last_stop.stop_line_ahead_m,
                  },
                }
              : {}),
          }
        : {}),
    };
  }
  if (full.traffic?.stopped_for_s > 0)
    state.stopped_for = rounded(full.traffic.stopped_for_s);
  if (full.traffic?.deadlock_release) state.deadlock_release = true;
  if (follower)
    state.rear_follower = {
      id: follower.vehicle_id,
      gap: follower.gap_m,
      closing_speed: follower.closing_speed_mps,
    };
  if (lead) {
    const queued = full.traffic?.queue;
    const following = full.scene?.following;
    state.following = queued
      ? {
          id: queued.lead_id,
          gap: queued.gap_m,
          target_gap: queued.target_gap_m,
          queue: true,
        }
      : {
          id: (following as NonNullable<typeof following>).id,
          gap: (following as NonNullable<typeof following>).gap_m,
          target_gap: (following as NonNullable<typeof following>)
            .minimum_gap_m,
        };
  }
  if (full.scene?.blocking_object)
    state.blocker = { ...full.scene.blocking_object };
  if (hazard)
    state.current_path_hazard = {
      id: hazard.id,
      in_s: hazard.in_s,
      point: [hazard.right_m, hazard.ahead_m],
      braking_helps: hazard.braking_reduces_risk,
    };
  if (nearby.length)
    state.traffic = table(
      "id,type,right,ahead,speed,heading,relative_forward_speed",
      nearby.map((o) => [
        o.id,
        o.type,
        rounded(o.right_m),
        rounded(o.ahead_m),
        rounded(o.speed_mps),
        rounded(o.heading_relative_deg),
        rounded(o.relative_velocity_ahead_mps),
      ]),
    ) as unknown as JsonValue;
  if (recovery)
    state.recovery = {
      blocked: full.recovery.blocked,
      road_distance: full.road.distance_to_road_m,
      target: full.recovery.target as unknown as JsonValue,
    };

  const columns = [
    "speed",
    "end_speed",
    "progress",
    "route_error",
    "lane_error",
    "heading_error",
    "end_right",
    "end_ahead",
  ];
  if (requiredStop) columns.push("line_after", "crosses_line", "stop_at_line");
  const needsRoadStatus = Object.values(vectors).some((v) => !v.stays_on_road);
  const needsLaneStatus = Object.values(vectors).some((v) => !v.stays_in_lane);
  if (needsRoadStatus) columns.push("on_road", "max_offroad_fraction");
  if (needsLaneStatus) columns.push("in_lane", "returning_to_lane");
  if (recovery)
    columns.push("recovery_distance", "road_distance_after", "on_road_after");
  const rows: Record<string, Row> = Object.fromEntries(
    Object.entries(vectors).map(([id, v]) => {
      const row: Row = [
        v.velocity_mps,
        v.end_speed_mps,
        v.route_progress_m,
        v.route_error_m,
        v.lane_error_m,
        v.heading_error_deg,
      ].map(rounded);
      row.push(
        ...point(
          v.end_position
            ? [v.end_position.right_m, v.end_position.ahead_m]
            : null,
        ),
      );
      if (requiredStop)
        row.push(
          rounded(v.stop_line_after_m),
          v.crosses_stop_line,
          !!v.stop_at_line,
        );
      if (needsRoadStatus) row.push(v.stays_on_road, v.max_offroad_fraction);
      if (needsLaneStatus) row.push(v.stays_in_lane, v.returning_to_lane);
      if (recovery)
        row.push(
          rounded(v.recovery_distance_m),
          rounded(v.road_distance_after_m),
          v.on_road_after,
        );
      return [id, row];
    }),
  );
  let candidateTable:
    | (Table & {
        conflicts?: Record<
          string,
          { object: string | null; in_s: number | null }
        >;
      })
    | null = null;
  if (Object.keys(rows).length) {
    candidateTable = {
      horizon_s: 3,
      ...(needsRoadStatus ? {} : { all_on_road: true }),
      ...(needsLaneStatus ? {} : { all_in_lane: true }),
      ...table(columns, rows),
    } as Table;
    const conflicts = Object.fromEntries(
      Object.entries(vectors)
        .filter(([, v]) => v.collision_predicted)
        .map(([id, v]) => [
          id,
          { object: v.collision_object_id, in_s: v.collision_in_s },
        ]),
    );
    if (Object.keys(conflicts).length) candidateTable.conflicts = conflicts;
    state.candidates = candidateTable as unknown as JsonValue;
  }

  const questions: Request["questions"] = {};
  const fixed: Answers = {};
  const ask = (
    id: string,
    criteria: Record<string, string | null>,
    instructions: string,
  ) => {
    const only = singleAnswer(criteria);
    if (only) fixed[id] = only;
    else if (Object.keys(criteria).length)
      questions[id] = { type: "choice", instructions, criteria };
  };
  ask(
    "motion",
    Object.fromEntries(
      Object.keys(motion).map((id) => [
        id,
        MOTION_OPTIONS[id as "drive" | "stop"],
      ]),
    ),
    MOTION_INSTRUCTIONS,
  );
  if (questions.motion)
    state.stop_reasons = full.stop_availability?.reasons ?? [];
  const situational = [
    requiredStop
      ? "Choose stop_at_line to approach then stop 0.5m before the line. Do not pick a faster crossing path."
      : intersection
        ? "Green or completed stop: continue through the line."
        : "",
    candidateTable?.conflicts || hazard
      ? "Conflicts are future predicted contacts; compare timing and paths. A current-path hazard may not affect another candidate."
      : "",
    recovery
      ? "Recover toward target, reducing recovery_distance and road_distance_after, then align with route; clear reverse is allowed."
      : "",
    ["onramp", "merge", "interstate"].includes(full.trip?.phase ?? "")
      ? "Accelerate on the ramp, match a merge gap, then cruise. Section boundaries are continuous road, not a stop or U-turn."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  ask(
    "vector",
    Object.fromEntries(
      Object.keys(vectors).map((id) => [
        id,
        candidateTable ? describeRow(candidateTable, id) : null,
      ]),
    ),
    // Situational rules first: a short-budget model cuts the question's tail.
    situational ? `${situational} ${VECTOR_GOAL}` : VECTOR_GOAL,
  );
  if (global?.routes && Object.keys(global.routes).length > 1) {
    state.navigation_choices = {
      position: global.position,
      destination: global.destination,
      routes: global.routes as unknown as JsonValue,
      junctions: table(
        "id,x,z,control",
        global.junctions.map((n) => [
          n.id,
          rounded(n.x),
          rounded(n.z),
          n.control,
        ]),
      ) as unknown as JsonValue,
      roads: table(
        "from,to,width,one_way,limit,kind",
        global.roads,
      ) as unknown as JsonValue,
      ...(global.stopped_traffic.length
        ? { stopped_traffic: global.stopped_traffic }
        : {}),
    };
    ask(
      "route",
      Object.fromEntries(Object.keys(global.routes).map((id) => [id, null])),
      "Choose a route to destination. Keep the route when on or near it. Alternatives address a sustained departure: consider join distance, direction and blocked junctions; avoid repeated reversals. World coordinates x=east,z=south,heading 0=north.",
    );
  }
  return { request: { state, questions }, fixed, aliases };
}

function describeRow(
  candidates: Table & { conflicts?: Record<string, { in_s: number | null }> },
  id: string,
): string | null {
  const row = (candidates.rows as Record<string, Row>)[id];
  if (!row) return null;
  const values: Record<string, Row[number] | undefined> = {
    ...candidates.shared,
  };
  candidates.columns.forEach((column, i) => {
    values[column] = row[i];
  });
  return describeCandidate(values, candidates.conflicts?.[id]);
}

/** Maps the vector answer's request ids back to the plan's candidate ids. */
export function expandAnswers(
  prepared: PreparedRequest,
  answers: Answers,
): Answers {
  const result: Answers = { ...answers, ...prepared.fixed };
  const vector = result.vector;
  if (vector?.type === "choice") {
    result.vector = {
      ...vector,
      choice: prepared.aliases[vector.choice] as string,
      ...(vector.probabilities
        ? {
            probabilities: Object.fromEntries(
              Object.entries(vector.probabilities).map(([id, p]) => [
                prepared.aliases[id] ?? id,
                p,
              ]),
            ),
          }
        : {}),
    };
  }
  return result;
}
