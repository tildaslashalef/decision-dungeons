// The Oracle's cases: one day at Harborline's harbour each, and the true
// chance of every question about it. A fixed hidden formula (a logistic
// over the day's facts, below) gives each chance; the outcome is drawn from
// it with the case's own seeded generator. The case keeps both, so a
// decider's probability is scored against the chance itself, not only the
// luck of one morning. Pure: the browser imports the types.

import { hash, pick, type Rng, seeded } from "../../lib/random.ts";
import type { TextCase } from "../text/cases.ts";
import { between, shuffle } from "../text/vocab.ts";

export const ORACLE_GENERATOR = "oracle@1";

export const FERRY = "MV Gannet";
export const ISLAND = "Holm";
export const DEPARTS = "07:30";

export const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type Compass = (typeof COMPASS)[number];
export const COMPASS_WORDS: Record<Compass, string> = {
  N: "north",
  NE: "north-east",
  E: "east",
  SE: "south-east",
  S: "south",
  SW: "south-west",
  W: "west",
  NW: "north-west",
};

export type Engine = "none" | "minor defect" | "open fault";
export type Advisory =
  | "none"
  | "caution"
  | "small-craft advisory"
  | "gale warning";
export type Bakery = "delivered" | "late" | "none";

export interface Captain {
  name: string;
  years: number;
}

export const CAPTAINS: Captain[] = [
  { name: "Captain Ines Morel", years: 24 },
  { name: "Captain Rhys Anwen", years: 15 },
  { name: "Captain Dara Quill", years: 9 },
  { name: "Captain Tobias Lund", years: 4 },
  { name: "First officer Sam Okoro, acting master", years: 1 },
];

/** A morning's facts: what the instruments, the crew office, and the port say. */
export interface Day {
  date: string;
  weekday: string;
  wind_kn: number;
  gust_kn: number;
  wind_from: Compass;
  swell_m: number;
  visibility_nm: number;
  crew_on_duty: number;
  crew_required: number;
  engine: Engine;
  advisory: Advisory;
  captain: Captain;
}

/** What the `many` level adds: passengers, freight, and the terminal café. */
export interface Extras {
  bookings: number;
  event: string | null;
  freight_lorries: number;
  cafe_staff: number;
  bakery: Bakery;
}

/** A fact a scattered notice first gives wrong, then corrects. */
export interface Correction {
  fact: "gust_kn" | "swell_m" | "visibility_nm" | "crew_on_duty";
  /** The value first issued. */
  issued: number;
}

/** A case's input: the day, and what its presentations need beyond the facts. */
export interface OracleInput {
  day: Day;
  extras?: Extras;
  /** Routine log entries, by time, among which the facts are written. */
  routine: { time: string; text: string }[];
  corrections: Correction[];
  /** The captain's note that disagrees with the instruments. */
  captain_note: string;
}

export type OracleQuestion = "sails" | "on_time" | "over_200" | "cafe_opens";

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const round4 = (p: number) => Math.round(p * 1e4) / 1e4;

/** How much the wind blows into the harbour mouth, which faces west: 1 from the west, 0 from the east half. */
export function intoMouth(from: Compass): number {
  const angle = (COMPASS.indexOf(from) * 45 * Math.PI) / 180;
  const west = (270 * Math.PI) / 180;
  return Math.max(0, Math.round(Math.cos(angle - west) * 1e6) / 1e6);
}

const ENGINE_WEIGHT: Record<Engine, number> = {
  none: 0,
  "minor defect": 0.39,
  "open fault": 1.76,
};
const ADVISORY_WEIGHT: Record<Advisory, number> = {
  none: 0,
  caution: 0.28,
  "small-craft advisory": 0.83,
  "gale warning": 1.87,
};

/**
 * The hidden formula: the chance the morning ferry sails. Its directions
 * are the handbook's (oracle.ts); its weights are told to no decider.
 */
export function sailOdds(d: Day): number {
  const short = Math.max(0, d.crew_required - d.crew_on_duty);
  const z =
    2.0 -
    0.028 * d.wind_kn -
    0.105 * Math.max(0, d.gust_kn - 22) -
    0.77 * Math.max(0, d.swell_m - 1.2) -
    0.041 * d.wind_kn * intoMouth(d.wind_from) -
    1.43 * Math.max(0, 1 - d.visibility_nm) -
    1.05 * short -
    ENGINE_WEIGHT[d.engine] -
    ADVISORY_WEIGHT[d.advisory] +
    0.028 * Math.min(d.captain.years, 25);
  return sigmoid(z);
}

const WEEKEND = new Set(["Saturday", "Sunday"]);

/** The chance of each `many` question, given the day; each is a marginal, sailing included. */
export function manyOdds(d: Day, x: Extras): Record<OracleQuestion, number> {
  const sails = sailOdds(d);
  const onTimeIfSails = sigmoid(
    1.6 -
      0.06 * Math.max(0, d.gust_kn - 18) -
      1.0 * Math.max(0, 1 - d.visibility_nm) -
      0.17 * Math.max(0, x.freight_lorries - 6) -
      (d.engine === "minor defect" ? 0.5 : 0),
  );
  const fullIfSails = sigmoid(
    0.1 +
      0.013 * (x.bookings - 170) +
      (WEEKEND.has(d.weekday) ? 0.5 : 0) +
      (x.event ? 0.7 : 0) -
      0.04 * Math.max(0, d.wind_kn - 15),
  );
  const cafe = sigmoid(
    0.9 -
      (x.cafe_staff >= 2 ? 0 : x.cafe_staff === 1 ? 1.5 : 3.6) -
      (x.bakery === "late" ? 0.6 : x.bakery === "none" ? 1.5 : 0) +
      0.13 * (x.freight_lorries - 6),
  );
  return {
    sails,
    on_time: sails * onTimeIfSails,
    over_200: sails * fullIfSails,
    cafe_opens: cafe,
  };
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** A morning between October 2026 and March 2027, from the generator; never the clock. */
function morning(rng: Rng): { date: string; weekday: string } {
  const at = new Date(Date.UTC(2026, 9, 1) + between(rng, 0, 181) * 86_400_000);
  return {
    date: `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`,
    weekday: WEEKDAYS[at.getUTCDay()] as string,
  };
}

const tenth = (rng: Rng, low: number, high: number) =>
  Math.round((low + rng() * (high - low)) * 10) / 10;

function weighted<T>(rng: Rng, options: [T, number][]): T {
  let u = rng() * options.reduce((n, [, w]) => n + w, 0);
  for (const [value, w] of options) {
    u -= w;
    if (u < 0) return value;
  }
  return (options.at(-1) as [T, number])[0];
}

function buildDay(rng: Rng): Day {
  const { date, weekday } = morning(rng);
  const regime = weighted(rng, [
    ["calm", 0.35],
    ["breezy", 0.4],
    ["stormy", 0.25],
  ] as const);
  const [wind, gustAdd, swell] =
    regime === "calm"
      ? [between(rng, 3, 14), between(rng, 3, 8), tenth(rng, 0.3, 1.2)]
      : regime === "breezy"
        ? [between(rng, 12, 24), between(rng, 5, 12), tenth(rng, 0.8, 2.3)]
        : [between(rng, 22, 36), between(rng, 6, 16), tenth(rng, 1.8, 4)];
  const sight = rng();
  const visibility =
    sight < 0.75
      ? between(rng, 3, 10)
      : sight < 0.9
        ? tenth(rng, 1, 2.9)
        : tenth(rng, 0.1, 0.9);
  const crewRequired = 6;
  const crew = weighted(rng, [
    [6, 0.78],
    [5, 0.13],
    [4, 0.05],
    [7, 0.04],
  ] as const);
  const engine = weighted<Engine>(rng, [
    ["none", 0.84],
    ["minor defect", 0.11],
    ["open fault", 0.05],
  ]);
  const advisory = weighted<Advisory>(
    rng,
    regime === "calm"
      ? [
          ["none", 0.9],
          ["caution", 0.1],
        ]
      : regime === "breezy"
        ? [
            ["none", 0.5],
            ["caution", 0.35],
            ["small-craft advisory", 0.15],
          ]
        : [
            ["caution", 0.2],
            ["small-craft advisory", 0.5],
            ["gale warning", 0.3],
          ],
  );
  return {
    date,
    weekday,
    wind_kn: wind,
    gust_kn: wind + gustAdd,
    wind_from: pick(rng, COMPASS),
    swell_m: swell,
    visibility_nm: visibility,
    crew_on_duty: crew,
    crew_required: crewRequired,
    engine,
    advisory,
    captain: pick(rng, CAPTAINS),
  };
}

function buildExtras(rng: Rng, d: Day): Extras {
  const event = weighted<string | null>(rng, [
    ["the Holm regatta", 0.12],
    ["market day on Holm", 0.15],
    [null, 0.73],
  ]);
  const base = WEEKEND.has(d.weekday) ? 150 : 90;
  return {
    bookings: base + between(rng, 0, 150) + (event ? between(rng, 20, 80) : 0),
    event,
    freight_lorries: between(rng, 0, 13),
    cafe_staff: weighted(rng, [
      [2, 0.68],
      [3, 0.12],
      [1, 0.14],
      [0, 0.06],
    ] as const),
    bakery: weighted<Bakery>(rng, [
      ["delivered", 0.8],
      ["late", 0.14],
      ["none", 0.06],
    ]),
  };
}

const ROUTINE = [
  "Night watch handed over to the day watch; nothing to report.",
  "Fuel barge booked for Thursday.",
  "Gull nets on the fish quay repaired.",
  "Pilot boat back from the night job, moored on the inner pontoon.",
  "Lamp out on the north pier head; the electrician is called.",
  "Two yachts left the marina for the bay.",
  "Harbour office coffee machine fixed again.",
  "Bins on the ferry quay emptied.",
  "Fish market opened; a good landing of mackerel.",
  "Tide gauge checked against the staff; reading true.",
  "Linkspan hydraulics greased, tested up and down.",
  "Lost-property box handed to the ticket office.",
  "Trawler Morning Star alongside the fish quay to land.",
  "Ticket office opened at 06:00.",
  "Security sweep of the passenger lounge, all clear.",
];
const ROUTINE_TIMES = [
  "05:05",
  "05:15",
  "05:40",
  "05:50",
  "06:05",
  "06:20",
  "06:35",
  "06:45",
];

/** A note that argues against the instruments: hopeful on a bad morning, gloomy on a good one. */
function captainNote(rng: Rng, odds: number): string {
  if (odds < 0.5)
    return pick(rng, [
      "Looked out at the mouth from the bridge: hardly a ripple, and the wind is nothing to speak of. We'll sail as usual.",
      "Flat calm by the look of it, whatever the readings say. Expect a normal crossing.",
      "Seen far worse than this. Sea is kind this morning; we go.",
    ]);
  return pick(rng, [
    "Don't like the look of the mouth at all: big seas breaking, and it is blowing hard. I doubt we go.",
    "Heavy swell at the breakwater from what I can see. Passengers should expect a cancellation.",
    "Ugly morning out there, wind rising. I would not count on sailing.",
  ]);
}

function corrections(rng: Rng, d: Day): Correction[] {
  const facts = shuffle(rng, [
    "gust_kn",
    "swell_m",
    "visibility_nm",
    "crew_on_duty",
  ] as const).slice(0, between(rng, 1, 2));
  return facts.map((fact) => {
    switch (fact) {
      case "gust_kn":
        return {
          fact,
          issued: Math.max(
            d.wind_kn + 1,
            d.gust_kn + pick(rng, [-9, -7, 7, 10]),
          ),
        };
      case "swell_m":
        return {
          fact,
          issued: Math.max(
            0.2,
            Math.round((d.swell_m + pick(rng, [-1.2, -0.9, 0.9, 1.3])) * 10) /
              10,
          ),
        };
      case "visibility_nm":
        return {
          fact,
          issued:
            d.visibility_nm < 1 ? between(rng, 3, 8) : tenth(rng, 0.2, 0.8),
        };
      default:
        return {
          fact,
          issued:
            d.crew_on_duty < d.crew_required
              ? d.crew_required
              : d.crew_required - 1,
        };
    }
  });
}

/** The questions each level's cases answer; the other levels play `numbers`' days. */
export const ORACLE_TRUTH: Record<string, OracleQuestion[]> = {
  numbers: ["sails"],
  many: ["sails", "on_time", "over_200", "cafe_opens"],
};

export function oracleCases(
  level: string,
  count: number,
  seed: number,
): TextCase[] {
  const asks = ORACLE_TRUTH[level];
  if (!asks) throw new Error(`oracle has no level ${level} to generate`);
  return Array.from({ length: count }, (_, index) => {
    const id = `${level}-${String(index + 1).padStart(4, "0")}`;
    // Each case its own generator, so the draws of one never move another's.
    const rng = seeded(hash(`oracle:${id}`, seed));
    const day = buildDay(rng);
    const extras = level === "many" ? buildExtras(rng, day) : undefined;
    const chances = extras
      ? manyOdds(day, extras)
      : ({ sails: sailOdds(day) } as Record<OracleQuestion, number>);
    const routine = shuffle(rng, ROUTINE).slice(0, 4);
    const times = shuffle(rng, ROUTINE_TIMES)
      .slice(0, 4)
      .sort((a, b) => (a < b ? -1 : 1));
    const input: OracleInput = {
      day,
      ...(extras ? { extras } : {}),
      routine: routine.map((text, i) => ({ time: times[i] as string, text })),
      corrections: corrections(rng, day),
      captain_note: captainNote(rng, chances.sails),
    };
    // The outcomes, drawn last and always all four, so every case uses its
    // generator the same way. Only a ferry that sails is on time or full.
    const u = [rng(), rng(), rng(), rng()] as [number, number, number, number];
    const sails = u[0] < chances.sails;
    const drawn: Record<OracleQuestion, boolean> = {
      sails,
      on_time: sails && u[1] < chances.on_time / chances.sails,
      over_200: sails && u[2] < chances.over_200 / chances.sails,
      cafe_opens: u[3] < chances.cafe_opens,
    };
    const truth: TextCase["truth"] = {};
    const odds: Record<string, number> = {};
    for (const q of asks) {
      truth[q] = drawn[q];
      odds[q] = round4(chances[q]);
    }
    return {
      id,
      level,
      lang: "en",
      input: input as unknown as TextCase["input"],
      truth,
      odds,
      why: asks
        .map(
          (q) =>
            `${q}: true chance ${Math.round(chances[q] * 100)}%, ${drawn[q] ? "yes" : "no"}`,
        )
        .join("; "),
    };
  });
}
