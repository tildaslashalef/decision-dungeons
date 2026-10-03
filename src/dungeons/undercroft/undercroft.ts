// Undercroft: a dungeon crawl, one move a turn. The hero starts in a seeded
// map of corridors and must reach the stairs; keys open the doors of their
// colour, a move that ends beside a monster costs a hit point, gold is a
// bonus. Each move changes the next situation, so mistakes compound. The
// map comes from the seed (no case set); the optimum is known by
// breadth-first search, and the rule is that search.

import type { Answers, ChoiceAnswer } from "../../contract/answer.ts";
import type { Decider } from "../../contract/decider.ts";
import { DecideError } from "../../contract/errors.ts";
import type {
  ChoiceQuestion,
  JsonValue,
  Request,
} from "../../contract/request.ts";
import type { DecisionRecord, Dungeon, Level, Outcome } from "../dungeon.ts";
import {
  at,
  blocked,
  buildMap,
  DIRECTIONS,
  type Direction,
  type KeyColor,
  type MapPlan,
  moved,
  nearMonster,
  optimalMoves,
  type Pos,
  SYMBOL,
  shortestPath,
  type Tile,
  type UndercroftMap,
} from "./map.ts";
import { mapPicture } from "./picture.ts";

/** A run may take this many times the optimum's moves in turns. */
export const TURN_LIMIT_FACTOR = 3;
/** A run passes reaching the stairs alive within this many times the optimum's moves. */
export const PASS_FACTOR = 2;
/** Under fog the hero sees this many tiles in every direction. */
export const SIGHT = 2;

interface UndercroftLevel extends Level {
  plan: MapPlan;
  /** The map's name, shared by levels that play the same maps. */
  map: string;
  fog?: true;
  /** What the request carries: the text map, the picture, or both. */
  show: "text" | "picture" | "both";
}

const LEVELS: UndercroftLevel[] = [
  {
    id: "corridors",
    title: "Corridors",
    description:
      "An 11 × 11 maze with a few loops: find the short way to the stairs. Pass within twice the optimum's moves.",
    plan: { size: 11, loops: 0.12, keys: 0, monsters: 0, gold: 3 },
    map: "corridors",
    show: "text",
  },
  {
    id: "keys",
    title: "Keys and doors",
    description:
      "An 11 × 11 maze with the gold door, then the red one on the way out: each key lies off the way, before its door.",
    plan: { size: 11, loops: 0, keys: 2, monsters: 0, gold: 2 },
    map: "keys",
    show: "text",
  },
  {
    id: "monsters",
    title: "Monsters",
    description:
      "A 13 × 13 maze with loops; monsters stand beside the short way, and every move that ends next to one costs one of three hit points. A safe way round always exists.",
    plan: { size: 13, loops: 0.25, keys: 0, monsters: 4, gold: 3 },
    map: "monsters",
    show: "text",
  },
  {
    id: "fog",
    title: "Fog",
    description:
      "A 13 × 13 maze where only the tiles within two steps are in sight; the rest are as remembered, or unseen. Explore to find the stairs.",
    plan: { size: 13, loops: 0.15, keys: 0, monsters: 0, gold: 3 },
    map: "fog",
    fog: true,
    show: "text",
  },
  {
    id: "picture",
    title: "The map as a picture",
    description:
      "The keys maps as a tile picture only; the text says just the hit points and the keys held.",
    plan: { size: 11, loops: 0, keys: 2, monsters: 0, gold: 2 },
    map: "keys",
    show: "picture",
    images: "only",
    tags: ["images"],
  },
  {
    id: "picture-both",
    title: "Picture and text",
    description:
      "The same keys maps as the picture and the text map together: does seeing add anything to reading?",
    plan: { size: 11, loops: 0, keys: 2, monsters: 0, gold: 2 },
    map: "keys",
    show: "both",
    images: "with-text",
    tags: ["images"],
  },
];

const levelOf = (id: string) => LEVELS.find((l) => l.id === id);

export interface UndercroftRun {
  seed: number;
  level: string;
  /** The map as it stands now: keys taken, doors opened, and gold picked up become floor. */
  map: UndercroftMap;
  hero: Pos;
  keys: KeyColor[];
  hp: number;
  gold: number;
  turns: number;
  steps: number;
  bumps: number;
  hpLost: number;
  optimal: number;
  limit: number;
  /** Every tile the hero stood on, in order, the start first. */
  trail: Pos[];
  /** Tiles seen so far ("row,col"); under fog only. */
  seen: Set<string>;
  reached: boolean;
  dead: boolean;
  records: DecisionRecord[];
  /** The last move's answer and where the hero stood to make it, for the view's arrows. */
  lastAnswer?: ChoiceAnswer;
  lastFrom?: Pos;
  /** The picture the next request carries, drawn at `turn` by `render`. */
  picture?: { turn: number; url: string };
}

const keyOf = (p: Pos) => `${p.row},${p.col}`;
const sameMap = (m: UndercroftMap): UndercroftMap => ({
  ...m,
  start: { ...m.start },
  stairs: { ...m.stairs },
  tiles: m.tiles.map((row) => [...row]),
});

/** The map a level plays for a seed, as built (before any move). */
export function levelMap(level: string, seed: number): UndercroftMap {
  const l = levelOf(level);
  if (!l) throw new Error(`undercroft has no level ${level}`);
  return buildMap(l.map, seed, l.plan);
}

function look(run: UndercroftRun): void {
  for (let dr = -SIGHT; dr <= SIGHT; dr++)
    for (let dc = -SIGHT; dc <= SIGHT; dc++)
      run.seen.add(keyOf({ row: run.hero.row + dr, col: run.hero.col + dc }));
}

/** Whether the hero sees `p` now (always, without fog). */
export function inSight(run: UndercroftRun, p: Pos): boolean {
  return (
    !levelOf(run.level)?.fog ||
    (Math.abs(p.row - run.hero.row) <= SIGHT &&
      Math.abs(p.col - run.hero.col) <= SIGHT)
  );
}

/** Whether the hero has ever seen `p` (always, without fog). */
export function known(run: UndercroftRun, p: Pos): boolean {
  return !levelOf(run.level)?.fog || run.seen.has(keyOf(p));
}

/** The map as the hero knows it, one string a row: `@` the hero, `?` unseen. */
export function textMap(run: UndercroftRun): string[] {
  return run.map.tiles.map((row, r) =>
    row
      .map((tile, c) => {
        const p = { row: r, col: c };
        if (r === run.hero.row && c === run.hero.col) return "@";
        return known(run, p) ? SYMBOL[tile] : "?";
      })
      .join(""),
  );
}

const LEGEND =
  "# wall, . floor, @ you, > the stairs out, a gold key, A gold door (opens once you hold the gold key), b red key, B red door (opens once you hold the red key), M monster, $ gold, ? not seen yet";

const RULES =
  "Walls block. Step on a key to pick it up; a door opens only once you hold the key of its colour. Every move that ends next to a monster (north, east, south, or west of it) costs a hit point, and at zero you die. Gold is a bonus, never worth a detour. Reach the stairs in as few moves as you can.";

const OPTIONS = {
  north: "up",
  east: "right",
  south: "down",
  west: "left",
};

const MOVE_TEXT: ChoiceQuestion = {
  type: "choice",
  instructions: `You are the hero (@) in a dungeon seen from above, north up. ${RULES} Which way do you move?`,
  criteria: OPTIONS,
};

const MOVE_PICTURE: ChoiceQuestion = {
  type: "choice",
  instructions: `The picture is a dungeon seen from above, north up, in square tiles: dark brick tiles are walls, grey stone is floor, you are the small figure in blue, the dark steps are the stairs out, a key opens the door of its colour (gold or red), the purple creature is a monster, and the coins are gold. ${RULES} Which way do you move?`,
  criteria: OPTIONS,
};

function goal(run: UndercroftRun, withPlace: boolean): string {
  const s = run.map.stairs;
  if (!withPlace) return "Reach the stairs out.";
  return known(run, s)
    ? `Reach the stairs (>) at row ${s.row}, column ${s.col} (rows and columns count from 0 at the top left).`
    : "Find the stairs (>) and reach them; they are not in sight yet.";
}

export function undercroftRequest(run: UndercroftRun): Request {
  const level = levelOf(run.level);
  if (!level) throw new Error(`undercroft has no level ${run.level}`);
  const facts: Record<string, JsonValue> = {
    keys_held: run.keys,
    hit_points: run.hp,
    moves_left: run.limit - run.turns,
  };
  if (level.show !== "text" && run.picture?.turn !== run.turns)
    throw new Error("undercroft: render the picture before observing");
  const pictured =
    level.show !== "text" && run.picture ? { images: [run.picture.url] } : {};
  if (level.show === "picture")
    return {
      state: { goal: goal(run, false), ...facts },
      questions: { move: MOVE_PICTURE },
      ...pictured,
    };
  return {
    state: {
      goal: goal(run, true),
      you_are_at: { row: run.hero.row, column: run.hero.col },
      ...facts,
      legend: LEGEND,
      map: textMap(run),
    },
    questions: { move: MOVE_TEXT },
    ...pictured,
  };
}

// --- The rule: breadth-first search on the map the request shows ----------

const FROM_SYMBOL = Object.fromEntries(
  Object.entries(SYMBOL).map(([tile, s]) => [s, tile as Tile]),
) as Record<string, Tile>;

/** The planner's move: the shortest safe way to the stairs, or to the nearest unseen tile under fog. */
export function plannedMove(request: Request): Direction {
  const s = request.state;
  const rows =
    s && typeof s === "object" && !Array.isArray(s) && Array.isArray(s.map)
      ? s.map.filter((r): r is string => typeof r === "string")
      : undefined;
  if (!rows?.length)
    throw new Error(
      "the map is only in the picture, which the rule cannot see",
    );
  const held =
    s &&
    typeof s === "object" &&
    !Array.isArray(s) &&
    Array.isArray(s.keys_held)
      ? (s.keys_held.filter((k) => typeof k === "string") as KeyColor[])
      : [];
  let hero: Pos | undefined;
  let stairs: Pos | undefined;
  const unseen = new Set<string>();
  const tiles = rows.map((row, r) =>
    [...row].map((ch, c) => {
      if (ch === "@") hero = { row: r, col: c };
      if (ch === ">") stairs = { row: r, col: c };
      if (ch === "?") unseen.add(keyOf({ row: r, col: c }));
      return ch === "@" ? "floor" : (FROM_SYMBOL[ch] ?? "wall");
    }),
  );
  if (!hero) throw new Error("no @ on the map");
  const m: UndercroftMap = {
    rows: rows.length,
    cols: rows[0]?.length ?? 0,
    tiles,
    start: hero,
    stairs: stairs ?? { row: -1, col: -1 },
    hp: 0,
  };
  const open = (p: Pos) => unseen.has(keyOf(p));
  const goal = stairs ? undefined : open;
  const plan = (safe: boolean) =>
    shortestPath(m, hero as Pos, held, {
      safe,
      open,
      ...(goal ? { goal } : {}),
    });
  return (plan(true) ?? plan(false))?.[0] ?? "north";
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
        answers: { move: { type: "choice", choice: plannedMove(request) } },
        timings: { total: 0 },
      };
    } catch (error) {
      throw new DecideError(
        "rejected",
        `the undercroft rule cannot read this request: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
};

// --- Playing ---------------------------------------------------------------

const BUMP: Record<string, string> = {
  wall: "walked into a wall",
  monster: "walked into a monster",
  "door:gold": "the gold door is locked",
  "door:red": "the red door is locked",
};

function finished(run: UndercroftRun): boolean {
  return run.reached || run.dead || run.turns >= run.limit;
}

export const undercroft: Dungeon<UndercroftRun> = {
  id: "undercroft",
  title: "Undercroft",
  description:
    "A dungeon crawl, one move a turn: keys and their doors, monsters to walk round, fog, and the map as text or as a tile picture. Scored in moves against the optimum.",
  levels: LEVELS.map(
    ({ plan: _, map: __, fog: ___, show: ____, ...level }) => level,
  ),
  create(seed, level) {
    const map = sameMap(levelMap(level, seed));
    const optimal = optimalMoves(map);
    const run: UndercroftRun = {
      seed,
      level,
      map,
      hero: { ...map.start },
      keys: [],
      hp: map.hp,
      gold: 0,
      turns: 0,
      steps: 0,
      bumps: 0,
      hpLost: 0,
      optimal,
      limit: optimal * TURN_LIMIT_FACTOR,
      trail: [{ ...map.start }],
      seen: new Set(),
      reached: false,
      dead: false,
      records: [],
    };
    look(run);
    return run;
  },
  async render(run) {
    const level = levelOf(run.level);
    if (!level || level.show === "text" || run.picture?.turn === run.turns)
      return;
    run.picture = {
      turn: run.turns,
      url: await mapPicture(run.map, run.hero),
    };
  },
  observe(run) {
    if (finished(run)) throw new Error("the undercroft run is over");
    return { request: undercroftRequest(run) };
  },
  apply(run, answers: Answers) {
    const answer = answers.move;
    if (answer?.type !== "choice" || finished(run)) return;
    const d = answer.choice as Direction;
    if (!DIRECTIONS.includes(d)) return;
    run.lastAnswer = answer;
    run.lastFrom = { ...run.hero };
    run.turns++;
    const target = moved(run.hero, d);
    const tile = at(run.map, target);
    const turn = `turn ${run.turns}: ${d}`;
    if (blocked(tile, new Set(run.keys))) {
      run.bumps++;
      const why = BUMP[tile] ?? "blocked";
      run.records.push({
        index: run.records.length,
        summary: `${turn}, ${why}`,
        violation: why,
      });
      return;
    }
    run.hero = target;
    run.steps++;
    run.trail.push({ ...target });
    const notes: string[] = [];
    const clear = () => {
      (run.map.tiles[target.row] as Tile[])[target.col] = "floor";
    };
    if (tile.startsWith("key:")) {
      run.keys.push(tile.slice(4) as KeyColor);
      clear();
      notes.push(`took the ${tile.slice(4)} key`);
    } else if (tile.startsWith("door:")) {
      clear();
      notes.push(`opened the ${tile.slice(5)} door`);
    } else if (tile === "gold") {
      run.gold++;
      clear();
      notes.push("picked up gold");
    } else if (tile === "stairs") {
      run.reached = true;
      notes.push("reached the stairs");
    }
    if (nearMonster(run.map, target) && !run.reached) {
      run.hp--;
      run.hpLost++;
      notes.push(
        `a monster struck, ${run.hp} hit point${run.hp === 1 ? "" : "s"} left`,
      );
      if (run.hp <= 0) {
        run.dead = true;
        notes.push("died");
      }
    }
    run.records.push({
      index: run.records.length,
      summary: `${turn} to (${target.row}, ${target.col})${notes.length ? `, ${notes.join(", ")}` : ""}`,
    });
  },
  advance(run) {
    look(run);
  },
  step() {},
  outcome(run): Outcome {
    const done = finished(run);
    return {
      finished: done,
      ...(done
        ? {
            passed:
              run.reached &&
              !run.dead &&
              run.steps <= PASS_FACTOR * run.optimal,
          }
        : {}),
      violations: run.bumps,
      metrics: {
        reached: run.reached ? 1 : 0,
        steps: run.steps,
        optimal: run.optimal,
        ...(run.reached ? { efficiency: run.optimal / run.steps } : {}),
        turns: run.turns,
        hp_lost: run.hpLost,
        gold: run.gold,
      },
      records: run.records,
    };
  },
  rule,
};
