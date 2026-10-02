// Night Tower: the decider is the tower controller of Port Alder's single
// runway. Each arrival at 2.5 nm is cleared to land or sent around; the
// departure at the head of the queue is released or held. A shift passes
// when every flight has landed or left with no incident: no landing over
// an occupied runway, no take-off inside a heavy's wake, and in low
// visibility a runway clear 45 s before each landing. Turn-based: time
// runs from one question to the next.

import type { Answers, ChoiceAnswer } from "../../contract/answer.ts";
import type { Decider } from "../../contract/decider.ts";
import { DecideError } from "../../contract/errors.ts";
import type { JsonValue, Request } from "../../contract/request.ts";
import type { DecisionRecord, Dungeon, Level, Outcome } from "../dungeon.ts";
import {
  ASK_EVERY_S,
  CLEAR_X,
  clearIn,
  clearToLand,
  createTower,
  DECISION_NM,
  DT,
  FINAL_NM,
  type Flight,
  flightById,
  goAround,
  HOLD,
  holdShort,
  LVP_MARGIN_S,
  NM,
  occupants,
  release,
  step,
  type Tower,
  type TrafficPlan,
  thresholdIn,
  typeOf,
  WAKE_HEAVY_S,
} from "./sim.ts";

/** Margins the baseline keeps beyond the exact times, seconds. */
const LAND_MARGIN_S = 6;
const DEPART_MARGIN_S = 8;

interface TowerLevel extends Level {
  plan: TrafficPlan;
}

const LEVELS: TowerLevel[] = [
  {
    id: "evening",
    title: "Quiet evening",
    description:
      "Six arrivals and four departures, five to seven miles apart. Every flight handled, no incident.",
    plan: {
      arrivals: 6,
      departures: 4,
      gapNm: [5, 7],
      heavyShare: 0.15,
      departureSpread: 600,
      lvp: false,
      sessionS: 1800,
    },
  },
  {
    id: "rush",
    title: "Rush hour",
    description:
      "Twelve arrivals three to five miles apart, ten departures to fit between them, heavies and their wake.",
    plan: {
      arrivals: 12,
      departures: 10,
      gapNm: [3, 5.5],
      heavyShare: 0.25,
      departureSpread: 900,
      lvp: false,
      sessionS: 2700,
    },
  },
  {
    id: "low-vis",
    title: "Low visibility",
    description: `Fog: slower line-ups and turn-offs, and the runway must be clear ${LVP_MARGIN_S} s before every landing.`,
    plan: {
      arrivals: 7,
      departures: 5,
      gapNm: [5, 7.5],
      heavyShare: 0.15,
      departureSpread: 700,
      lvp: true,
      sessionS: 2700,
    },
  },
  {
    id: "go-around",
    title: "Go-around check",
    description:
      "A departure rejects its take-off and stops on the runway as an arrival nears 2.5 miles: send it around, then land it.",
    plan: {
      arrivals: 1,
      departures: 1,
      gapNm: [5, 5],
      heavyShare: 0,
      departureSpread: 0,
      lvp: false,
      sessionS: 900,
    },
  },
];

export interface TowerRun {
  tower: Tower;
  level: string;
  decisions: number;
  records: DecisionRecord[];
  /** Alerts already turned into records. */
  alertsSeen: number;
  /** The go-around check: what the controller did with the arrival. */
  check: { arrival: string; orderedGoAround: boolean } | null;
}

/** The scripted start of the go-around check. */
function goAroundCheck(t: Tower): TowerRun["check"] {
  const departure = t.flights.find((f) => f.kind === "departure") as Flight;
  const arrival = t.flights.find((f) => f.kind === "arrival") as Flight;
  Object.assign(departure, {
    phase: "takeoff",
    appearAt: 0,
    phaseAt: 0,
    x: HOLD.x,
    z: 0,
    heading: 0,
    rejectAt: 650,
    // A jet: still on its wheels at 650 m, where it stops.
    type: "B738",
    callsign: "HBL77",
    spoken: "Harborline 77",
    livery: "#0e8a7e",
  });
  // A jet, at the threshold well before the stopped aircraft can clear.
  Object.assign(arrival, {
    appearAt: 0,
    phase: "final",
    x: -4.6 * NM,
    type: "A320",
    callsign: "DAL1729",
    spoken: "Delta 1729",
    livery: "#c8102e",
  });
  arrival.alt = 4.6 * NM * Math.tan((3 * Math.PI) / 180) + 15;
  t.events.push({
    time: 0,
    who: "pilot",
    text: `Alder Tower, ${departure.spoken}, rejecting take-off, stopping on the runway.`,
  });
  return { arrival: arrival.id, orderedGoAround: false };
}

const levelOf = (id: string) => LEVELS.find((l) => l.id === id);

const round1 = (v: number) => Math.round(v * 10) / 10;
const clock = (t: Tower) => {
  const s = 21 * 3600 + Math.floor(t.time);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}Z`;
};

const PHASE_WORDS: Record<string, string> = {
  landing: "landing roll",
  vacating: "turning off",
  lineup: "lining up",
  takeoff: "take-off roll",
  stopped: "stopped on the runway",
};

/** When a cleared arrival will have landed and left the runway, from now. */
function landedClearIn(t: Tower, f: Flight): number | null {
  const copy: Flight = {
    ...f,
    phase: "landing",
    x: 0,
    alt: 15,
    speed: typeOf(f).approach,
  };
  const after = clearIn({ ...t, time: t.time + thresholdIn(f) }, copy);
  return after === null ? null : Math.round(thresholdIn(f) + after);
}

/** The next landing: seconds until the first arrival on final reaches the threshold. */
function nextLanding(t: Tower): number | null {
  const times = t.flights
    .filter((f) => f.phase === "final" || f.phase === "cleared")
    .map(thresholdIn);
  return times.length ? Math.round(Math.min(...times)) : null;
}

function wakeWait(t: Tower): number {
  return t.lastHeavyRoll === null
    ? 0
    : Math.max(0, Math.ceil(WAKE_HEAVY_S - (t.time - t.lastHeavyRoll)));
}

/** When the runway is next clear of everything on it and every cleared arrival ahead of `arrival`. */
function runwayFreeIn(t: Tower, arrival?: Flight): number | null {
  let worst = 0;
  for (const f of occupants(t)) {
    const s = clearIn(t, f);
    if (s === null) return null;
    worst = Math.max(worst, s);
  }
  for (const f of t.flights)
    if (
      f.phase === "cleared" &&
      f !== arrival &&
      (!arrival || thresholdIn(f) < thresholdIn(arrival))
    ) {
      const s = landedClearIn(t, f);
      if (s === null) return null;
      worst = Math.max(worst, s);
    }
  return worst;
}

function towerRequest(run: TowerRun): { request: Request } {
  const t = run.tower;
  const lvp = t.plan.lvp;
  const land = flightById(t, t.pendingLand);
  const depart = flightById(t, t.pendingDepart);
  const arrivals = t.flights
    .filter((f) => f.phase === "final" || f.phase === "cleared")
    .sort((a, b) => thresholdIn(a) - thresholdIn(b))
    .slice(0, 4);
  const holding = t.flights
    .filter((f) => f.phase === "holding" || f.phase === "taxi_out")
    .slice(0, 3);
  const state: Record<string, JsonValue> = {
    rules: [
      "Runway 27 is the only runway.",
      lvp
        ? `Low visibility: a landing needs the runway empty ${LVP_MARGIN_S} s before the arrival reaches the threshold.`
        : "A landing needs the runway empty when the arrival reaches the threshold.",
      `A departure holds the runway from line-up until airborne past ${CLEAR_X} m (needs_runway_s).`,
      `After a heavy's take-off roll, the next roll waits ${WAKE_HEAVY_S} s.`,
    ].join(" "),
    time: clock(t),
    runway: {
      clear_now: occupants(t).length === 0,
      occupied_by: occupants(t).map((f) => ({
        callsign: f.callsign,
        type: f.type,
        doing: PHASE_WORDS[f.phase] ?? f.phase,
        at_m: Math.round(f.x),
        clear_in_s: clearIn(t, f),
      })),
    },
    arrivals: arrivals.map((f) => ({
      callsign: f.callsign,
      type: f.type,
      wake: typeOf(f).wake,
      distance_nm: round1(-f.x / NM),
      threshold_in_s: Math.round(thresholdIn(f)),
      cleared: f.phase === "cleared",
      ...(f.phase === "cleared"
        ? { runway_clear_in_s: landedClearIn(t, f) }
        : {}),
    })),
    departures: holding.map((f) => ({
      callsign: f.callsign,
      type: f.type,
      wake: typeOf(f).wake,
      ready: f.phase === "holding",
      ...(f.phase === "holding"
        ? { waiting_s: Math.round(t.time - (f.holdingSince ?? t.time)) }
        : {}),
    })),
  };
  const questions: Request["questions"] = {};
  if (land) {
    const eta = Math.round(thresholdIn(land));
    const free = runwayFreeIn(t, land);
    const need = lvp
      ? `${LVP_MARGIN_S} s before it gets there`
      : "when it gets there";
    questions.land = {
      type: "choice",
      instructions: `${land.spoken} (${land.type}) is at ${DECISION_NM} nm, ${eta} s from the threshold. Clear it to land only if the runway will be empty ${need}; otherwise send it around.`,
      criteria: {
        land: `clear to land: runway free in ${free === null ? "unknown (blocked)" : `${free} s`}, threshold in ${eta} s`,
        go_around: `go around: rejoins a ${FINAL_NM} mile final in about 4 minutes`,
      },
    };
  }
  if (depart) {
    const needs = clearIn(t, depart) ?? 0;
    const next = nextLanding(t);
    const wake = wakeWait(t);
    state.ready = {
      callsign: depart.callsign,
      needs_runway_s: needs,
      next_landing_in_s: next,
      wake_wait_s: wake,
    };
    const margin = lvp ? ` plus ${LVP_MARGIN_S} s` : "";
    questions.depart = {
      type: "choice",
      instructions: `${depart.spoken} (${depart.type}) is ready at the holding point. Release it only if it needs the runway less time than the next landing is away${margin}, the runway is empty now, and no heavy rolled in the last ${WAKE_HEAVY_S} s.`,
      criteria: {
        take_off: `line up and take off: needs the runway ${needs} s, next landing in ${next === null ? "none on final" : `${next} s`}, wake wait ${wake} s, runway ${occupants(t).length ? "busy" : "empty"} now`,
        hold: `hold short; asked again in ${ASK_EVERY_S} s`,
      },
    };
  }
  return { request: { state, questions } };
}

type Json = Record<string, JsonValue>;
const isObject = (v: JsonValue | undefined): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const numbers = (text: string) =>
  [...text.matchAll(/(\d+) s\b/g)].map((m) => Number(m[1]));

function pickAnswer(keys: string[], choice: string): ChoiceAnswer {
  return {
    type: "choice",
    choice,
    probabilities: Object.fromEntries(
      keys.map((k) => [k, k === choice ? 1 : 0]),
    ),
  };
}

/** The baseline: exact timing arithmetic over the facts the request states. */
function decideByRule(request: Request): Answers {
  const state = request.state;
  if (!isObject(state)) throw new Error("the state is not a tower board");
  const lvp =
    typeof state.rules === "string" && state.rules.includes("Low visibility");
  const answers: Answers = {};
  const land = request.questions.land;
  if (land?.type === "choice") {
    const text = land.criteria.land ?? "";
    const blocked = text.includes("unknown");
    const [free = 0, eta = 0] = numbers(text);
    const ok =
      !blocked && free + (lvp ? LVP_MARGIN_S : 0) + LAND_MARGIN_S <= eta;
    answers.land = pickAnswer(
      Object.keys(land.criteria),
      ok ? "land" : "go_around",
    );
  }
  const depart = request.questions.depart;
  if (depart?.type === "choice") {
    const ready = isObject(state.ready) ? state.ready : {};
    const runway = isObject(state.runway) ? state.runway : {};
    const needs = Number(ready.needs_runway_s ?? 0);
    const next = ready.next_landing_in_s;
    const wake = Number(ready.wake_wait_s ?? 0);
    const room =
      next === null || next === undefined
        ? true
        : needs + (lvp ? LVP_MARGIN_S : 0) + DEPART_MARGIN_S <= Number(next);
    const ok = runway.clear_now === true && wake === 0 && room;
    answers.depart = pickAnswer(
      Object.keys(depart.criteria),
      ok ? "take_off" : "hold",
    );
  }
  return answers;
}

const rule: Decider = {
  id: "rule",
  label: "Fixed rule",
  models: async () => [{ id: "baseline", label: "Baseline", available: true }],
  status: async () => ({ configured: true, reachable: true }),
  async decide(request) {
    try {
      return {
        decider: "rule",
        model: "baseline",
        answers: decideByRule(request),
        timings: { total: 0 },
      };
    } catch (error) {
      throw new DecideError(
        "rejected",
        `the tower rule cannot read this request: ${String(error)}`,
      );
    }
  },
};

/** Turns new alerts into violation records. */
function noteAlerts(run: TowerRun): void {
  const alerts = run.tower.events.filter((e) => e.who === "alert");
  for (const alert of alerts.slice(run.alertsSeen))
    run.records.push({
      index: run.records.length,
      summary: `${alert.time.toFixed(0)} s · ${alert.text}`,
      violation: alert.text,
    });
  run.alertsSeen = alerts.length;
}

const pending = (t: Tower) => !!(t.pendingLand || t.pendingDepart);

const LANDED = new Set(["landing", "vacating", "taxi_in", "done"]);
const AIRBORNE = new Set(["climb", "done"]);
const handled = (f: Flight) =>
  f.kind === "arrival"
    ? LANDED.has(f.phase)
    : AIRBORNE.has(f.phase) && f.alt > 0;

/** The scripted world of the go-around check: the stopped departure clears after 150 s. */
function script(run: TowerRun): void {
  if (!run.check) return;
  const t = run.tower;
  for (const f of t.flights)
    if (f.phase === "stopped" && t.time - f.phaseAt > 150) {
      f.phase = "vacating";
      f.phaseAt = t.time;
      f.exitX = f.x;
      t.events.push({
        time: t.time,
        who: "pilot",
        text: `${f.spoken}, vacating the runway.`,
      });
    }
}

function finished(run: TowerRun): boolean {
  const t = run.tower;
  if (t.time >= t.plan.sessionS) return true;
  if (run.check) {
    const arrival = flightById(t, run.check.arrival);
    return !!arrival && LANDED.has(arrival.phase);
  }
  return t.flights.every(handled);
}

export const tower: Dungeon<TowerRun> = {
  id: "tower",
  title: "Night Tower",
  description:
    "Work the tower at Port Alder International after dark: clear arrivals to land or send them around, release departures between them.",
  levels: LEVELS.map(({ id, title, description }) => ({
    id,
    title,
    description,
  })),
  create(seed, level) {
    const l = levelOf(level);
    if (!l) throw new Error(`tower has no level ${level}`);
    const t = createTower(seed, l.plan);
    const check = level === "go-around" ? goAroundCheck(t) : null;
    return { tower: t, level, decisions: 0, records: [], alertsSeen: 0, check };
  },
  observe(run) {
    return towerRequest(run);
  },
  apply(run, answers: Answers) {
    const t = run.tower;
    const land = flightById(t, t.pendingLand);
    const depart = flightById(t, t.pendingDepart);
    if (land && answers.land?.type === "choice") {
      run.decisions++;
      if (answers.land.choice === "land") clearToLand(t, land);
      else {
        goAround(t, land, true);
        if (run.check?.arrival === land.id) run.check.orderedGoAround = true;
      }
      run.records.push({
        index: run.records.length,
        summary: `${clock(t)} ${land.callsign}: ${answers.land.choice === "land" ? "cleared to land" : "go around"}`,
      });
      t.pendingLand = null;
    }
    if (depart && answers.depart?.type === "choice") {
      run.decisions++;
      if (answers.depart.choice === "take_off") {
        release(t, depart);
        run.records.push({
          index: run.records.length,
          summary: `${clock(t)} ${depart.callsign}: cleared for take-off`,
        });
      } else holdShort(t, depart);
      t.pendingDepart = null;
    }
  },
  advance(run) {
    const t = run.tower;
    while (!pending(t) && !finished(run)) {
      script(run);
      step(t);
    }
    noteAlerts(run);
  },
  step(run, dt) {
    const t = run.tower;
    for (
      let s = 0;
      s < Math.round(dt / DT) && !pending(t) && !finished(run);
      s++
    ) {
      script(run);
      step(t);
    }
    noteAlerts(run);
  },
  outcome(run): Outcome {
    const t = run.tower;
    const done = finished(run);
    const arrivals = t.flights.filter((f) => f.kind === "arrival");
    const departures = t.flights.filter((f) => f.kind === "departure");
    const released = departures.filter(
      (f) => f.releasedAt !== undefined && f.holdingSince !== undefined,
    );
    const metrics: Record<string, number> = {
      decisions: run.decisions,
      sim_s: Math.round(t.time),
      landed: arrivals.filter((f) => LANDED.has(f.phase)).length,
      departed: departures.filter((f) => AIRBORNE.has(f.phase) && f.alt > 0)
        .length,
      go_arounds: arrivals.reduce((n, f) => n + f.goArounds, 0),
      flights: t.flights.length,
    };
    if (released.length)
      metrics.mean_hold_s = Math.round(
        released.reduce(
          (n, f) => n + ((f.releasedAt ?? 0) - (f.holdingSince ?? 0)),
          0,
        ) / released.length,
      );
    const complete = run.check
      ? LANDED.has(flightById(t, run.check.arrival)?.phase ?? "")
      : t.flights.every(handled);
    return {
      finished: done,
      ...(done
        ? {
            passed:
              complete &&
              t.violations === 0 &&
              (!run.check || run.check.orderedGoAround),
          }
        : {}),
      violations: t.violations,
      metrics,
      records: run.records,
    };
  },
  rule,
};

export { decideByRule, towerRequest };
