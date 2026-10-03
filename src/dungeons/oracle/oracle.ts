// The Oracle: will Harborline's morning ferry sail? Each case is one day at
// the harbour, and each question has a true chance, so a decider's
// probability is scored against the truth itself as well as against the
// one morning that happened. The same days are shown as a table, a log,
// scattered notices, and a log with a misleading captain's note; a fifth
// level asks four questions about each day. Cases come from a case set
// (generate.ts writes them).

import type { Answers } from "../../contract/answer.ts";
import type {
  JsonValue,
  NoulQuestion,
  Request,
} from "../../contract/request.ts";
import type { TextCase } from "../text/cases.ts";
import {
  type TextLevel,
  type TextRun,
  textDungeon,
} from "../text/text-dungeon.ts";
import {
  COMPASS_WORDS,
  type Correction,
  type Day,
  DEPARTS,
  FERRY,
  ISLAND,
  type OracleInput,
} from "./generate.ts";
import { calibration, type Forecast, forecastMetrics } from "./score.ts";

/**
 * A run passes when its mean distance from the true chances is at most
 * this: under the best wind-and-swell forecaster's expected 0.115, so a
 * pass means reading more of the day (docs/plan.md § Decisions).
 */
export const PASS_TRUTH_GAP = 0.1;

const HANDBOOK = `Harbour master's handbook for the ${DEPARTS} ferry to ${ISLAND}. Gusts matter more than the mean wind: above about 22 knots every extra knot of gust counts against her. A swell over 1.2 m counts against her, the more the higher it is. The harbour mouth faces west: a wind from the west, south-west, or north-west is worse than the same wind from the east, and the stronger it blows the more so. Visibility under one mile counts against her, the thicker the fog the more. She needs her full crew of six, and each hand short counts heavily. An open engine fault counts heavily, a minor defect a little. A port caution counts a little, a small-craft advisory more, a gale warning most. A captain with long years in command sails in weather a new one would not. When a captain's note disagrees with the instruments, believe the instruments.`;

const SAILS: NoulQuestion = {
  type: "noul",
  instructions: `${HANDBOOK} Will the morning ferry sail? Answer with the chance that she does.`,
  criteria: { true: "she sails this morning", false: "she stays in harbour" },
};

const ON_TIME: NoulQuestion = {
  type: "noul",
  instructions: `She is on time when she leaves within ten minutes of ${DEPARTS}; if she does not sail she is not on time. Strong gusts, poor visibility, more than six freight lorries to load, and a minor engine defect make her late. Will she sail on time? Answer with the chance that she does.`,
};

const OVER_200: NoulQuestion = {
  type: "noul",
  instructions:
    "She carries over 200 passengers only if she sails. Advance bookings are the best guide; a weekend and an event on Holm bring more people, a strong wind keeps them at home. Will she sail with more than 200 passengers aboard? Answer with the chance that she does.",
};

const CAFE_OPENS: NoulQuestion = {
  type: "noul",
  instructions:
    "The terminal café opens with two staff on the rota; with one it often stays shut, with none it almost never opens. A late bakery delivery counts against it, no delivery more. Lorry drivers are its morning trade, so a busy freight morning helps. Will the terminal café open this morning? Answer with the chance that it does.",
};

const LEVELS: TextLevel[] = [
  {
    id: "numbers",
    title: "Numbers",
    description:
      "The day's facts as a table: wind, gusts, swell, fog, crew, engine, advisory, captain. Scored against each day's true chance; pass within 0.10 of it on average.",
    questions: { sails: SAILS },
  },
  {
    id: "log",
    title: "The harbour log",
    description:
      "The same days as the harbour master's log, the facts among routine entries.",
    questions: { sails: SAILS },
    casesOf: "numbers",
  },
  {
    id: "scattered",
    title: "Scattered notices",
    description:
      "The same days as notices from the met office, the crew office, the engineer, and the port; some are corrected by a later one.",
    questions: { sails: SAILS },
    casesOf: "numbers",
  },
  {
    id: "contradiction",
    title: "The captain's note",
    description:
      "The same log, and a captain's note that argues against the instruments. The chance follows the instruments.",
    questions: { sails: SAILS },
    casesOf: "numbers",
  },
  {
    id: "many",
    title: "Four questions a day",
    description:
      "Does she sail, on time, with over 200 aboard, and does the café open: each with its own true chance, all in one request.",
    questions: {
      sails: SAILS,
      on_time: ON_TIME,
      over_200: OVER_200,
      cafe_opens: CAFE_OPENS,
    },
    tags: ["many-questions"],
  },
];

const inputOf = (c: TextCase): OracleInput => c.input as unknown as OracleInput;

const crewLine = (onDuty: number, required: number) =>
  onDuty >= required
    ? `${onDuty} of ${required} crew signed on.`
    : `${onDuty} of ${required} crew signed on, ${required - onDuty} short; no relief found.`;

const ENGINE_LINE = {
  none: "engines tested, no defects.",
  "minor defect":
    "minor defect on the port generator, logged; the ship can run.",
  "open fault": "open fault on the port main engine, repair under way.",
};

const advisoryLine = (d: Day) =>
  d.advisory === "none"
    ? "no advisory in force."
    : `${d.advisory} in force for the approaches.`;

const visibilityLine = (nm: number) =>
  nm < 1
    ? `visibility at the mouth ${nm} nm, fog bank over the entrance.`
    : `visibility at the mouth ${nm} nm.`;

const header = (d: Day) =>
  `Harbour log, ${d.weekday} ${d.date}. ${FERRY} due to sail ${DEPARTS} for ${ISLAND}.`;

/** The facts as the instruments and offices give them, by time; `value` overrides a corrected fact. */
function factEntries(
  d: Day,
  value: Partial<Record<Correction["fact"], number>> = {},
): { time: string; text: string }[] {
  const gust = value.gust_kn ?? d.gust_kn;
  return [
    {
      time: "05:30",
      text: `Breakwater station: wind ${d.wind_kn} kn from the ${COMPASS_WORDS[d.wind_from]}, gusting ${gust} kn.`,
    },
    {
      time: "05:35",
      text: `Outer buoy: swell ${value.swell_m ?? d.swell_m} m.`,
    },
    {
      time: "05:55",
      text: `Harbour office: ${visibilityLine(value.visibility_nm ?? d.visibility_nm)}`,
    },
    {
      time: "06:00",
      text: `Crew office: ${crewLine(value.crew_on_duty ?? d.crew_on_duty, d.crew_required)}`,
    },
    { time: "06:10", text: `Chief engineer: ${ENGINE_LINE[d.engine]}` },
    { time: "06:15", text: `Port authority: ${advisoryLine(d)}` },
    {
      time: "06:25",
      text: `Bridge: ${d.captain.name} in command this morning, ${d.captain.years} year${d.captain.years === 1 ? "" : "s"} as master.`,
    },
  ];
}

const byTime = (a: { time: string }, b: { time: string }) =>
  a.time < b.time ? -1 : a.time > b.time ? 1 : 0;

function log(input: OracleInput, note: boolean): string {
  const entries = [...factEntries(input.day), ...input.routine];
  if (note)
    entries.push({
      time: "06:40",
      text: `Captain's note: "${input.captain_note}"`,
    });
  return [
    header(input.day),
    ...entries.sort(byTime).map((e) => `${e.time} ${e.text}`),
  ].join("\n");
}

const CORRECTION_TEXT: Record<
  Correction["fact"],
  (d: Day, issued: number) => string
> = {
  gust_kn: (d, issued) =>
    `Breakwater station, correction: gusts ${d.gust_kn} kn, not ${issued} kn as issued at 05:30.`,
  swell_m: (d, issued) =>
    `Outer buoy, correction: swell ${d.swell_m} m; the 05:35 reading of ${issued} m came from a faulty sensor.`,
  visibility_nm: (d, issued) =>
    `Harbour office, correction: ${visibilityLine(d.visibility_nm)} The 05:55 figure of ${issued} nm was wrong.`,
  crew_on_duty: (d, issued) =>
    `Crew office, correction: ${crewLine(d.crew_on_duty, d.crew_required)} The 06:00 count of ${issued} was wrong.`,
};

/** Every notice of the morning in order, the corrected facts first issued wrong. */
function notices(input: OracleInput): string[] {
  const issued = Object.fromEntries(
    input.corrections.map((c) => [c.fact, c.issued]),
  );
  const fixes = input.corrections.map((c, i) => ({
    time: i ? "06:50" : "06:40",
    text: CORRECTION_TEXT[c.fact](input.day, c.issued),
  }));
  return [
    ...factEntries(input.day, issued),
    ...input.routine.map((r) => ({
      time: r.time,
      text: `Harbour office: ${r.text}`,
    })),
    ...fixes,
  ]
    .sort(byTime)
    .map((e) => `${e.time} ${e.text}`);
}

function table(input: OracleInput): Record<string, JsonValue> {
  const d = input.day;
  const x = input.extras;
  return {
    day: `${d.weekday} ${d.date}`,
    sailing: `${FERRY}, ${DEPARTS} to ${ISLAND}`,
    wind_kn: d.wind_kn,
    gust_kn: d.gust_kn,
    wind_from: d.wind_from,
    swell_m: d.swell_m,
    visibility_nm: d.visibility_nm,
    crew_on_duty: d.crew_on_duty,
    crew_required: d.crew_required,
    engine: d.engine,
    port_advisory: d.advisory,
    captain: d.captain.name,
    captain_years_in_command: d.captain.years,
    ...(x
      ? {
          advance_bookings: x.bookings,
          event_on_holm: x.event ?? "none",
          freight_lorries_booked: x.freight_lorries,
          cafe_staff_on_rota: x.cafe_staff,
          bakery_delivery: x.bakery,
        }
      : {}),
  };
}

/** What the decider reads at a level: a table, a log, or the notices. */
export function oracleState(c: TextCase, level: string): JsonValue {
  const input = inputOf(c);
  switch (level) {
    case "log":
      return log(input, false);
    case "contradiction":
      return log(input, true);
    case "scattered":
      return notices(input);
    default:
      return table(input);
  }
}

/** The fitted baseline's weights: the best logistic on wind and swell alone. */
const RULE = { bias: 3.05, wind: -0.109, swell: -0.76 };

/** The latest value a text states after `label`, e.g. the wind after a correction. */
function lastNumber(lines: string[], pattern: RegExp): number | undefined {
  let found: number | undefined;
  for (const line of lines) {
    const m = pattern.exec(line);
    if (m?.[1]) found = Number(m[1]);
  }
  return found;
}

/** The wind and swell the request states, from a table, a log, or notices. */
function windAndSwell(state: JsonValue): { wind: number; swell: number } {
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const { wind_kn, swell_m } = state;
    if (typeof wind_kn === "number" && typeof swell_m === "number")
      return { wind: wind_kn, swell: swell_m };
  }
  const lines = Array.isArray(state)
    ? state.filter((s): s is string => typeof s === "string")
    : typeof state === "string"
      ? state.split("\n")
      : [];
  const wind = lastNumber(lines, /\bwind (\d+(?:\.\d+)?) kn/);
  const swell = lastNumber(lines, /\bswell (\d+(?:\.\d+)?) m\b/);
  if (wind === undefined || swell === undefined)
    throw new Error("no wind and swell in the state");
  return { wind, swell };
}

/**
 * The baseline: a partial forecaster that reads only the wind and the
 * swell. It says nothing about the other questions beyond needing her to
 * sail: half her chance for those, an even chance for the café.
 */
function rule(request: Request): Answers {
  const { wind, swell } = windAndSwell(request.state);
  const p =
    Math.round(
      1e4 /
        (1 + Math.exp(-(RULE.bias + RULE.wind * wind + RULE.swell * swell))),
    ) / 1e4;
  const answers: Answers = {};
  for (const id of Object.keys(request.questions))
    answers[id] = {
      type: "noul",
      noul: id === "sails" ? p : id === "cafe_opens" ? 0.5 : p / 2,
    };
  return answers;
}

/** A day's answered questions as forecasts against their outcomes and truths. */
export function dayForecasts(
  c: TextCase | undefined,
  answers: Answers | undefined,
): Forecast[] {
  if (!c?.odds || !answers) return [];
  return Object.entries(c.odds).flatMap(([q, truth]) => {
    const answer = answers[q];
    return answer?.type === "noul"
      ? [{ p: answer.noul, outcome: c.truth[q] === true, truth }]
      : [];
  });
}

/** Each answered question of the run as a forecast against its outcome and its truth. */
export function forecasts(run: TextRun): Forecast[] {
  return run.answers.flatMap((answers, i) =>
    dayForecasts(run.cases[i], answers),
  );
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

export const oracle = textDungeon({
  id: "oracle",
  title: "The Oracle",
  description:
    "Will Harborline's morning ferry sail? Every day has a true chance, so a forecaster's probabilities are scored against the truth itself, not only against what happened.",
  levels: LEVELS,
  state: (c, level) => oracleState(c, level.id),
  rule,
  summary: (c) => `${inputOf(c).day.weekday} ${inputOf(c).day.date}`,
  record(c, answers) {
    const parts = Object.entries(c.odds ?? {}).map(([q, truth]) => {
      const a = answers[q];
      const p = a?.type === "noul" ? pct(a.noul) : "—";
      return `${q} ${p} (true ${pct(truth)}, ${c.truth[q] ? "yes" : "no"})`;
    });
    return `${inputOf(c).day.weekday} ${inputOf(c).day.date}: ${parts.join(", ")}`;
  },
  score(run) {
    const f = forecasts(run);
    const metrics = forecastMetrics(f);
    return {
      passed:
        metrics.truth_gap !== undefined && metrics.truth_gap <= PASS_TRUTH_GAP,
      metrics: {
        cases: run.cases.length,
        decided: run.records.length,
        ...metrics,
      },
      ...(f.length ? { calibration: calibration(f) } : {}),
    };
  },
});
