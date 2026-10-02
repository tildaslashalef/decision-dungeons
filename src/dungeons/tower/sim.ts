// Night Tower's simulation: one runway, arrivals on a three-degree final,
// departures taxiing to the holding point, and the tower's two decisions:
// clear an arrival to land or send it around, release a departure or hold
// it. Pure and deterministic: fixed 50 ms steps, a seeded schedule, and
// occupancy times computed by stepping a copy of a flight on its own (no
// flight's motion depends on another's), so they are exact.
//
// Coordinates: metres; x along runway 27 from its threshold (0) toward its
// far end (3,000), z to the north (taxiway and apron), alt above ground.

import { hash, pick, type Rng, seeded } from "../../lib/random.ts";

export const DT = 0.05;
export const NM = 1852;
export const RUNWAY_LENGTH = 3000;
export const RUNWAY_WIDTH = 45;
/** Where wheels meet the runway, past the threshold. */
export const TOUCHDOWN_X = 350;
/** Rapid exits to the taxiway, by distance from the threshold. */
export const EXITS = [1350, 1850, 2450];
/** A departure frees the runway once airborne past this point. */
export const CLEAR_X = 2400;
export const TAXIWAY_Z = 180;
/** Where departures wait, short of the runway, and where they line up. */
export const HOLD = { x: 40, z: 90 };
/** Arrivals are handed to the tower here, and the landing question waits here. */
export const FINAL_NM = 10;
export const DECISION_NM = 2.5;
/** A held departure is asked again this often. */
export const ASK_EVERY_S = 10;
/** Wake turbulence: after a heavy's take-off roll, the next one waits this long. */
export const WAKE_HEAVY_S = 120;
/** Low visibility: the runway must be clear this long before a landing. */
export const LVP_MARGIN_S = 45;
const GLIDE = Math.tan((3 * Math.PI) / 180);
const THRESHOLD_HEIGHT = 15;
const EXIT_SPEED = 14;
const TAXI_SPEED = 9;
/** A flight off the runway centre by this much has vacated it. */
const VACATED_Z = 35;
const APRON = { x: 1500, z: 430 };

export type Wake = "heavy" | "medium" | "light";

export interface AircraftType {
  code: string;
  wake: Wake;
  /** Final approach speed, m/s. */
  approach: number;
  /** Rotation speed, m/s. */
  vr: number;
  /** Take-off acceleration and landing deceleration, m/s². */
  accel: number;
  decel: number;
  length: number;
  span: number;
}

export const TYPES: Record<string, AircraftType> = {
  A320: {
    code: "A320",
    wake: "medium",
    approach: 70,
    vr: 75,
    accel: 2.4,
    decel: 2.4,
    length: 37.6,
    span: 35.8,
  },
  B738: {
    code: "B738",
    wake: "medium",
    approach: 72,
    vr: 77,
    accel: 2.3,
    decel: 2.3,
    length: 39.5,
    span: 35.8,
  },
  E175: {
    code: "E175",
    wake: "medium",
    approach: 66,
    vr: 70,
    accel: 2.6,
    decel: 2.6,
    length: 31.7,
    span: 28.7,
  },
  DH8D: {
    code: "DH8D",
    wake: "medium",
    approach: 62,
    vr: 60,
    accel: 2.5,
    decel: 2.8,
    length: 32.8,
    span: 28.4,
  },
  B77W: {
    code: "B77W",
    wake: "heavy",
    approach: 77,
    vr: 85,
    accel: 1.9,
    decel: 2.0,
    length: 73.9,
    span: 64.8,
  },
  A359: {
    code: "A359",
    wake: "heavy",
    approach: 74,
    vr: 82,
    accel: 2.0,
    decel: 2.1,
    length: 66.8,
    span: 64.8,
  },
  B763: {
    code: "B763",
    wake: "heavy",
    approach: 72,
    vr: 80,
    accel: 2.0,
    decel: 2.2,
    length: 54.9,
    span: 47.6,
  },
  PC12: {
    code: "PC12",
    wake: "light",
    approach: 45,
    vr: 45,
    accel: 2.8,
    decel: 3.0,
    length: 14.4,
    span: 16.3,
  },
};

/** Operators: the ICAO prefix, the spoken callsign, the livery colour, the types they fly. */
const OPERATORS: [string, string, string, string[]][] = [
  ["ASA", "Alaska", "#1d3f6e", ["B738", "E175"]],
  ["DAL", "Delta", "#c8102e", ["A320", "B738", "A359"]],
  ["UAL", "United", "#2a3c7e", ["B738", "B77W"]],
  ["SWA", "Southwest", "#304cb2", ["B738"]],
  ["BAW", "Speedbird", "#18325c", ["A320", "B77W"]],
  ["DLH", "Lufthansa", "#0a1d3d", ["A320", "A359"]],
  ["QXE", "Horizon", "#2c5d8f", ["E175", "DH8D"]],
  ["FDX", "FedEx", "#4d148c", ["B763", "B77W"]],
  ["HBL", "Harborline", "#0e8a7e", ["B763"]],
  ["N", "November", "#e9ecef", ["PC12"]],
];

export type ArrivalPhase =
  | "scheduled"
  | "final"
  | "cleared"
  | "landing"
  | "vacating"
  | "taxi_in"
  | "go_around"
  | "circuit"
  | "done";
export type DeparturePhase =
  | "scheduled"
  | "taxi_out"
  | "holding"
  | "lineup"
  | "takeoff"
  | "stopped"
  | "climb"
  | "done";

export interface Flight {
  id: string;
  callsign: string;
  /** As said on the radio: "Delta 1729". */
  spoken: string;
  type: string;
  livery: string;
  kind: "arrival" | "departure";
  phase: ArrivalPhase | DeparturePhase;
  x: number;
  z: number;
  alt: number;
  speed: number;
  /** Radians; 0 points along the runway toward its far end. */
  heading: number;
  appearAt: number;
  phaseAt: number;
  goArounds: number;
  /** Arrivals: the landing question was asked on this approach. */
  asked?: boolean;
  /** Departures: when it reached the holding point, and when to ask next. */
  holdingSince?: number;
  nextAsk?: number;
  /** Departures: when the tower released it. */
  releasedAt?: number;
  /** Departures: a scripted rejected take-off stops here (the go-around check). */
  rejectAt?: number;
  exitX?: number;
  /** Taxi path progress, metres. */
  along?: number;
}

export interface TowerEvent {
  time: number;
  /** "tower" and "pilot" are radio calls; "alert" is an incident. */
  who: "tower" | "pilot" | "alert";
  text: string;
}

export interface TrafficPlan {
  arrivals: number;
  departures: number;
  /** Spacing on final between successive arrivals, nautical miles. */
  gapNm: [number, number];
  heavyShare: number;
  /** Departures reach the holding point spread over this many seconds. */
  departureSpread: number;
  lvp: boolean;
  /** The shift ends here, finished or not. */
  sessionS: number;
}

export interface Tower {
  time: number;
  plan: TrafficPlan;
  flights: Flight[];
  /** Oldest first. */
  events: TowerEvent[];
  violations: number;
  /** The last heavy's take-off roll began here. */
  lastHeavyRoll: number | null;
  /** When the runway last became empty (Infinity while occupied). */
  clearSince: number;
  pendingLand: string | null;
  pendingDepart: string | null;
}

/** Positions along a polyline, for taxiing. */
function along(path: { x: number; z: number }[], s: number) {
  let left = s;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as { x: number; z: number };
    const b = path[i] as { x: number; z: number };
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (left <= len) {
      const t = len ? left / len : 0;
      return {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        heading: Math.atan2(b.z - a.z, b.x - a.x),
        done: false,
      };
    }
    left -= len;
  }
  const end = path[path.length - 1] as { x: number; z: number };
  const before = path[path.length - 2] ?? end;
  return {
    x: end.x,
    z: end.z,
    heading: Math.atan2(end.z - before.z, end.x - before.x),
    done: true,
  };
}

/** The taxi route from the apron to a queue slot (0 is the holding point). */
function outbound(slot: number) {
  const queueX = HOLD.x + 90 * slot;
  return [
    { x: APRON.x, z: APRON.z },
    { x: APRON.x, z: TAXIWAY_Z },
    { x: queueX, z: TAXIWAY_Z },
    ...(slot === 0 ? [{ x: HOLD.x, z: HOLD.z }] : []),
  ];
}

function inbound(exitX: number) {
  return [
    { x: exitX + 120, z: TAXIWAY_Z },
    { x: APRON.x, z: TAXIWAY_Z },
    { x: APRON.x, z: APRON.z },
  ];
}

export function createTower(seed: number, plan: TrafficPlan): Tower {
  const rng: Rng = seeded(hash("tower", seed));
  const used = new Set<string>();
  const flight = (
    kind: "arrival" | "departure",
    appearAt: number,
    heavy: boolean,
  ): Flight => {
    const candidates = OPERATORS.filter(([, , , types]) =>
      types.some((t) => (TYPES[t]?.wake === "heavy") === heavy),
    );
    const [prefix, spoken, livery, types] = pick(rng, candidates);
    const type = pick(
      rng,
      types.filter((t) => (TYPES[t]?.wake === "heavy") === heavy),
    );
    let number: string;
    do {
      number =
        prefix === "N"
          ? `${Math.floor(100 + rng() * 900)}${pick(rng, ["AK", "PA", "TW", "CS"])}`
          : String(Math.floor(100 + rng() * 2900));
    } while (used.has(prefix + number));
    used.add(prefix + number);
    return {
      id: `${kind}-${prefix}${number}`,
      callsign: `${prefix}${number}`,
      spoken: `${spoken} ${number}`,
      type,
      livery,
      kind,
      phase: "scheduled",
      x: kind === "arrival" ? -FINAL_NM * NM : APRON.x,
      z: kind === "arrival" ? 0 : APRON.z,
      alt: kind === "arrival" ? FINAL_NM * NM * GLIDE + THRESHOLD_HEIGHT : 0,
      speed: 0,
      heading: kind === "arrival" ? 0 : -Math.PI / 2,
      appearAt,
      phaseAt: 0,
      goArounds: 0,
    };
  };
  const flights: Flight[] = [];
  // Arrivals: handed over at 10 nm, spaced by the plan's gap at the threshold.
  let at = 5;
  for (let i = 0; i < plan.arrivals; i++) {
    const f = flight("arrival", at, rng() < plan.heavyShare);
    flights.push(f);
    const gap = (plan.gapNm[0] + rng() * (plan.gapNm[1] - plan.gapNm[0])) * NM;
    // The next one is handed over when this one has flown the gap.
    at += gap / typeOf(f).approach;
  }
  for (let i = 0; i < plan.departures; i++)
    flights.push(
      flight(
        "departure",
        Math.round(rng() * plan.departureSpread),
        rng() < plan.heavyShare,
      ),
    );
  flights.sort((a, b) => a.appearAt - b.appearAt || (a.id < b.id ? -1 : 1));
  return {
    time: 0,
    plan,
    flights,
    events: [],
    violations: 0,
    lastHeavyRoll: null,
    clearSince: 0,
    pendingLand: null,
    pendingDepart: null,
  };
}

export const typeOf = (f: Flight): AircraftType =>
  TYPES[f.type] as AircraftType;

function say(t: Tower, who: TowerEvent["who"], text: string): void {
  t.events.push({ time: Math.round(t.time * 10) / 10, who, text });
}

const RUNWAY_PHASES = new Set(["landing", "lineup", "takeoff", "stopped"]);

/** On the runway: rolling, lined up, stopped, or still turning off it. */
export function onRunway(f: Flight): boolean {
  if (RUNWAY_PHASES.has(f.phase))
    return f.phase !== "takeoff" || f.x < CLEAR_X || f.alt < 15;
  return f.phase === "vacating" && f.z < VACATED_Z;
}

/** Moves one flight by one step; touches nothing else. */
function move(t: Tower, f: Flight, dt: number): void {
  const type = typeOf(f);
  const lvp = t.plan.lvp;
  switch (f.phase) {
    case "final":
    case "cleared": {
      f.speed = type.approach;
      f.x += f.speed * dt;
      f.alt = Math.max(0, -f.x) * GLIDE + THRESHOLD_HEIGHT;
      return;
    }
    case "landing": {
      if (f.x < TOUCHDOWN_X) {
        f.x += f.speed * dt;
        f.alt = Math.max(0, THRESHOLD_HEIGHT * (1 - f.x / TOUCHDOWN_X));
        return;
      }
      f.alt = 0;
      f.speed = Math.max(EXIT_SPEED, f.speed - type.decel * dt);
      f.x += f.speed * dt;
      f.exitX ??=
        EXITS.find(
          (e) =>
            e >= f.x + (f.speed ** 2 - EXIT_SPEED ** 2) / (2 * type.decel) - 5,
        ) ?? RUNWAY_LENGTH - 100;
      if (f.x >= f.exitX) {
        f.phase = "vacating";
        f.phaseAt = t.time;
      }
      return;
    }
    case "vacating": {
      // A curved turn-off over 10 s (16 in low visibility) onto the taxiway.
      const span = lvp ? 16 : 10;
      const k = Math.min(1, (t.time - f.phaseAt) / span);
      const ease = k * k * (3 - 2 * k);
      f.x = (f.exitX as number) + 120 * k;
      f.z = TAXIWAY_Z * ease;
      f.heading = Math.atan2(TAXIWAY_Z * 6 * k * (1 - k), 120);
      f.speed = EXIT_SPEED * (1 - k * 0.4);
      if (k >= 1) {
        f.phase = "taxi_in";
        f.phaseAt = t.time;
        f.along = 0;
      }
      return;
    }
    case "taxi_in": {
      f.along = (f.along ?? 0) + TAXI_SPEED * dt;
      const p = along(inbound(f.exitX as number), f.along);
      f.x = p.x;
      f.z = p.z;
      f.heading = p.heading;
      f.speed = TAXI_SPEED;
      if (p.done) f.phase = "done";
      return;
    }
    case "go_around": {
      f.speed = Math.min(type.approach + 15, f.speed + 1.5 * dt);
      f.x += f.speed * dt;
      f.alt = Math.min(600, f.alt + 9 * dt);
      if (t.time - f.phaseAt > 70) {
        f.phase = "circuit";
        f.phaseAt = t.time;
      }
      return;
    }
    case "circuit":
      return;
    case "taxi_out":
    case "holding": {
      const slot = queueSlot(t, f);
      f.along = (f.along ?? 0) + TAXI_SPEED * dt;
      const path = outbound(slot);
      const p = along(path, f.along);
      f.x = p.x;
      f.z = p.z;
      f.heading = p.heading;
      f.speed = p.done ? 0 : TAXI_SPEED;
      if (p.done && slot === 0 && f.phase === "taxi_out") {
        f.phase = "holding";
        f.phaseAt = t.time;
        f.holdingSince = t.time;
        f.nextAsk = t.time;
        say(
          t,
          "pilot",
          `Alder Tower, ${f.spoken}, holding short runway 27, ready.`,
        );
      }
      // Moving up the queue restarts the walk from the slot's own path.
      if (p.done && slot > 0) f.along = pathLength(path);
      return;
    }
    case "lineup": {
      const span = lvp ? 30 : 20;
      const k = Math.min(1, (t.time - f.phaseAt) / span);
      f.x = HOLD.x;
      f.z = HOLD.z * (1 - k);
      f.heading = k < 0.8 ? -Math.PI / 2 : 0;
      f.speed = k < 1 ? 3 : 0;
      if (k >= 1) {
        f.heading = 0;
        f.phase = "takeoff";
        f.phaseAt = t.time;
        f.speed = 0;
      }
      return;
    }
    case "takeoff": {
      if (f.rejectAt !== undefined && f.x >= f.rejectAt) {
        f.phase = "stopped";
        f.phaseAt = t.time;
        return;
      }
      f.speed += type.accel * dt;
      f.x += f.speed * dt;
      if (f.speed >= type.vr)
        f.alt += Math.min(14, (f.speed - type.vr) * 1.2 + 4) * dt;
      if (f.x > CLEAR_X && f.alt > 15) {
        f.phase = "climb";
        f.phaseAt = t.time;
      }
      return;
    }
    case "stopped": {
      f.speed = Math.max(0, f.speed - 4 * dt);
      f.x += f.speed * dt;
      return;
    }
    case "climb": {
      f.speed = Math.min(type.vr * 1.4, f.speed + 1.2 * dt);
      f.x += f.speed * dt;
      f.alt += 10 * dt;
      if (f.alt > 900) f.phase = "done";
      return;
    }
    default:
      return;
  }
}

const pathLength = (path: { x: number; z: number }[]) =>
  path.slice(1).reduce((sum, p, i) => {
    const a = path[i] as { x: number; z: number };
    return sum + Math.hypot(p.x - a.x, p.z - a.z);
  }, 0);

/** A departure's place in the queue, 0 at the holding point: whoever holds first, then by when each left the gate. */
function queueSlot(t: Tower, f: Flight): number {
  const queue = t.flights
    .filter(
      (o) =>
        o.kind === "departure" &&
        (o.phase === "taxi_out" || o.phase === "holding"),
    )
    .sort(
      (a, b) =>
        Number(b.phase === "holding") - Number(a.phase === "holding") ||
        a.appearAt - b.appearAt ||
        (a.id < b.id ? -1 : 1),
    );
  return Math.min(queue.indexOf(f), 4);
}

/**
 * Seconds until `f` leaves the runway, stepping a copy of it alone; null
 * when it will not (a stopped aircraft), 0 when it is off already.
 */
export function clearIn(t: Tower, f: Flight): number | null {
  if (!onRunway(f) && f.phase !== "holding") return 0;
  if (f.phase === "stopped") return null;
  const copy: Flight = { ...f };
  const ghost: Tower = { ...t, flights: [copy], events: [] };
  if (copy.phase === "holding") {
    copy.phase = "lineup";
    copy.phaseAt = ghost.time;
  }
  let s = 0;
  while ((onRunway(copy) || copy.phase === "lineup") && s < 600) {
    ghost.time += DT;
    move(ghost, copy, DT);
    s += DT;
  }
  return Math.round(s);
}

/** Seconds until an arrival on final crosses the threshold. */
export const thresholdIn = (f: Flight): number =>
  Math.max(0, -f.x) / typeOf(f).approach;

export const occupants = (t: Tower): Flight[] => t.flights.filter(onRunway);

/** One 50 ms step of the whole world, with the rules checked as they happen. */
export function step(t: Tower): void {
  t.time = Math.round((t.time + DT) * 1000) / 1000;
  for (const f of t.flights) {
    if (f.phase === "scheduled" && t.time >= f.appearAt) {
      f.phase = f.kind === "arrival" ? "final" : "taxi_out";
      f.phaseAt = t.time;
      f.along = 0;
      if (f.kind === "arrival")
        say(
          t,
          "pilot",
          `Alder Tower, ${f.spoken}, ${FINAL_NM} mile final runway 27.`,
        );
    }
    if (f.phase === "circuit" && t.time - f.phaseAt > 150 && rejoinGap(t)) {
      Object.assign(f, {
        phase: "final",
        phaseAt: t.time,
        x: -FINAL_NM * NM,
        z: 0,
        alt: FINAL_NM * NM * GLIDE + THRESHOLD_HEIGHT,
        heading: 0,
        asked: false,
      });
      say(
        t,
        "pilot",
        `Alder Tower, ${f.spoken}, back on a ${FINAL_NM} mile final.`,
      );
    }
  }
  const before = occupants(t).length;
  for (const f of t.flights) {
    const wasFinal = f.phase === "final" || f.phase === "cleared";
    const x = f.x;
    const takeoff = f.phase === "lineup";
    move(t, f, DT);
    if (takeoff && f.phase === "takeoff") rollStarted(t, f);
    if (wasFinal && x < 0 && f.x >= 0) crossThreshold(t, f);
  }
  const after = occupants(t).length;
  if (after === 0 && before > 0) t.clearSince = t.time;
  if (after > 0) t.clearSince = Number.POSITIVE_INFINITY;
  pend(t);
}

/** A go-around may rejoin when no arrival is within 3 nm of the 10 nm handover. */
function rejoinGap(t: Tower): boolean {
  return !t.flights.some(
    (o) =>
      (o.phase === "final" ||
        o.phase === "cleared" ||
        (o.phase === "scheduled" &&
          o.kind === "arrival" &&
          o.appearAt - t.time < 50)) &&
      -o.x > (FINAL_NM - 3) * NM,
  );
}

function rollStarted(t: Tower, f: Flight): void {
  if (t.lastHeavyRoll !== null && t.time - t.lastHeavyRoll < WAKE_HEAVY_S) {
    t.violations++;
    say(
      t,
      "alert",
      `Wake turbulence: ${f.callsign} rolled ${Math.round(t.time - t.lastHeavyRoll)} s after a heavy, under ${WAKE_HEAVY_S} s.`,
    );
  }
  if (typeOf(f).wake === "heavy") t.lastHeavyRoll = t.time;
}

function crossThreshold(t: Tower, f: Flight): void {
  const others = occupants(t).filter((o) => o !== f);
  if (f.phase !== "cleared") {
    // Never cleared: the crew goes around on its own; an unanswered tower is not an incident.
    goAround(t, f, false);
    return;
  }
  if (others.length) {
    t.violations++;
    say(
      t,
      "alert",
      `Runway incursion: ${f.callsign} reached the threshold with ${others.map((o) => o.callsign).join(", ")} on the runway. The crew went around.`,
    );
    goAround(t, f, false);
    return;
  }
  if (t.plan.lvp && t.time - t.clearSince < LVP_MARGIN_S) {
    t.violations++;
    say(
      t,
      "alert",
      `Low visibility: the runway was clear only ${Math.round(t.time - t.clearSince)} s before ${f.callsign} landed, under ${LVP_MARGIN_S} s.`,
    );
  }
  f.phase = "landing";
  f.phaseAt = t.time;
}

export function goAround(t: Tower, f: Flight, ordered: boolean): void {
  f.phase = "go_around";
  f.phaseAt = t.time;
  f.goArounds++;
  if (ordered) {
    say(
      t,
      "tower",
      `${f.spoken}, go around, I say again, go around. Climb runway heading, 2,000 feet.`,
    );
    say(t, "pilot", `Going around, ${f.spoken}.`);
  }
}

/** Raises the questions due now: one arrival at 2.5 nm, the head of the departure queue. */
function pend(t: Tower): void {
  if (!t.pendingLand) {
    const due = t.flights.find(
      (f) => f.phase === "final" && !f.asked && -f.x <= DECISION_NM * NM,
    );
    if (due) {
      due.asked = true;
      t.pendingLand = due.id;
    }
  }
  if (!t.pendingDepart) {
    const busy = t.flights.some(
      (f) => f.phase === "lineup" || (f.phase === "takeoff" && f.x < CLEAR_X),
    );
    const head = t.flights.find(
      (f) => f.phase === "holding" && queueSlot(t, f) === 0,
    );
    if (head && !busy && t.time >= (head.nextAsk ?? 0))
      t.pendingDepart = head.id;
  }
}

export const flightById = (t: Tower, id: string | null): Flight | undefined =>
  id ? t.flights.find((f) => f.id === id) : undefined;

export function clearToLand(t: Tower, f: Flight): void {
  f.phase = "cleared";
  say(t, "tower", `${f.spoken}, runway 27, cleared to land, wind 260 at 8.`);
  say(t, "pilot", `Cleared to land 27, ${f.spoken}.`);
}

export function release(t: Tower, f: Flight): void {
  f.phase = "lineup";
  f.phaseAt = t.time;
  f.releasedAt = t.time;
  say(
    t,
    "tower",
    `${f.spoken}, runway 27, line up, cleared for take-off, wind 260 at 8.`,
  );
  say(t, "pilot", `Cleared for take-off 27, ${f.spoken}.`);
}

export function holdShort(t: Tower, f: Flight): void {
  if ((f.nextAsk ?? 0) <= (f.holdingSince ?? 0))
    say(t, "tower", `${f.spoken}, hold short runway 27, landing traffic.`);
  f.nextAsk = t.time + ASK_EVERY_S;
}

export const finishedFlights = (t: Tower): number =>
  t.flights.filter((f) => f.phase === "done" || f.phase === "climb").length;
