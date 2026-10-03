import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "../src/contract/answer.ts";
import { decideWith } from "../src/contract/decider.ts";
import type { Request } from "../src/contract/request.ts";
import { randomDecider } from "../src/deciders/random.ts";
import type { AnyDungeon } from "../src/dungeons/dungeon.ts";
import {
  type OracleInput,
  oracleCases,
  sailOdds,
} from "../src/dungeons/oracle/generate.ts";
import { oracle, oracleState } from "../src/dungeons/oracle/oracle.ts";
import {
  binOf,
  calibration,
  forecastMetrics,
  poolCalibration,
} from "../src/dungeons/oracle/score.ts";
import { runEpisode } from "../src/dungeons/run.ts";
import type { TextRun } from "../src/dungeons/text/text-dungeon.ts";
import { buildSet, CaseStore, GENERATORS } from "../src/server/cases.ts";
import { fakeRender } from "./fake-render.ts";

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

const base = buildSet("oracle", "base", 1, GENERATORS.oracle?.base ?? {});
const dungeon = oracle as AnyDungeon;
const ids = (run: unknown) => (run as TextRun).cases.map((c) => c.id);

/** A decider that knows the hidden formula: it answers each question's true chance. */
function knowing(run: TextRun) {
  return async (request: Request): Promise<Decision> => {
    const c = run.cases.find(
      (k) =>
        JSON.stringify(oracleState(k, run.level)) ===
        JSON.stringify(request.state),
    );
    if (!c?.odds) throw new Error("no case for this request");
    return {
      decider: "oracle",
      model: "truth",
      answers: Object.fromEntries(
        Object.keys(request.questions).map((q) => [
          q,
          { type: "noul" as const, noul: c.odds?.[q] ?? 0 },
        ]),
      ),
      timings: { total: 0 },
    };
  };
}

describe("the oracle's cases", () => {
  test("outcomes are drawn from the true chances", () => {
    const cases = oracleCases("many", 3000, 7);
    for (const q of ["sails", "on_time", "over_200", "cafe_opens"]) {
      const odds = cases.map((c) => c.odds?.[q] as number);
      const rate =
        cases.filter((c) => c.truth[q] === true).length / cases.length;
      const mean = odds.reduce((n, p) => n + p, 0) / odds.length;
      expect(Math.abs(rate - mean)).toBeLessThan(0.03);
      for (const p of odds) expect(p >= 0 && p <= 1).toBe(true);
    }
    for (const c of cases) {
      expect(c.odds?.on_time as number).toBeLessThanOrEqual(
        c.odds?.sails as number,
      );
      // Only a ferry that sails is on time or carries anyone.
      if (!c.truth.sails) {
        expect(c.truth.on_time).toBe(false);
        expect(c.truth.over_200).toBe(false);
      }
    }
  });

  test("each case's chance is the formula's, and a case does not move when more are written", () => {
    const few = oracleCases("numbers", 5, 1);
    const more = oracleCases("numbers", 50, 1);
    expect(more.slice(0, 5)).toEqual(few);
    for (const c of few)
      expect(c.odds?.sails).toBeCloseTo(
        sailOdds((c.input as unknown as OracleInput).day),
        4,
      );
  });

  test("the table, the log, the notices, and the note show the same days", () => {
    const runs = ["numbers", "log", "scattered", "contradiction"].map((l) =>
      dungeon.create(3, l, { cases: base }),
    );
    for (const run of runs) expect(ids(run)).toEqual(ids(runs[0]));
    const c = (runs[0] as TextRun).cases[0];
    if (!c) throw new Error("no case");
    const input = c.input as unknown as OracleInput;
    const notices = oracleState(c, "scattered") as string[];
    const fix = notices.findIndex((n) => n.includes("correction"));
    expect(fix).toBeGreaterThan(0);
    expect(oracleState(c, "contradiction")).toContain(input.captain_note);
    expect(oracleState(c, "log")).not.toContain("Captain's note");
  });

  test("the store keeps each case's odds", () => {
    const home = mkdtempSync(join(tmpdir(), "dd-oracle-"));
    homes.push(home);
    const store = new CaseStore(home, { render: fakeRender });
    const set = buildSet("oracle", "small", 3, { numbers: 10 });
    expect(store.write(set)).toBe("written");
    expect(store.load("oracle", "small")?.cases).toEqual(set.cases);
    store.close();
  });
});

describe("the oracle's scores", () => {
  test("a forecaster who knows the truth has no gap, and the oracle's Brier", async () => {
    for (const level of ["numbers", "many"]) {
      const run = dungeon.create(2, level, { cases: base }) as TextRun;
      const result = await runEpisode(
        dungeon,
        level,
        2,
        { id: "oracle", model: "truth" },
        knowing(run),
        { cases: base },
      );
      const m = result.outcome.metrics;
      expect(m.truth_gap).toBe(0);
      expect(m.brier).toBeCloseTo(m.oracle_brier as number, 10);
      expect(result.outcome.passed).toBe(true);
      const bins = result.outcome.calibration ?? [];
      expect(bins.reduce((n, b) => n + b.n, 0)).toBe(
        level === "many" ? 80 : 20,
      );
      for (const b of bins)
        expect(b.forecast).toBeCloseTo(b.truth as number, 10);
    }
  });

  test("the rule reads every presentation alike and beats random", async () => {
    const play = async (level: string, id: string, decide = dungeon.rule) =>
      runEpisode(
        dungeon,
        level,
        1,
        { id, model: id },
        (r) =>
          decideWith(decide, r, {
            model: id,
            seed: 1,
            signal: AbortSignal.timeout(1000),
          }),
        { cases: base },
      );
    const numbers = await play("numbers", "rule");
    for (const level of ["log", "scattered", "contradiction"])
      expect((await play(level, "rule")).outcome.metrics).toEqual(
        numbers.outcome.metrics,
      );
    const random = await play("numbers", "random", randomDecider());
    expect(numbers.outcome.metrics.truth_gap as number).toBeLessThan(
      random.outcome.metrics.truth_gap as number,
    );
  });

  test("a forecast on a bin's edge falls in the bin above", () => {
    expect([0, 0.2, 0.4, 0.6, 0.8, 1].map(binOf)).toEqual([0, 1, 2, 3, 4, 4]);
    expect(binOf(0.5999)).toBe(2);
  });

  test("metrics leave out what does not apply and survive certain answers", () => {
    expect(forecastMetrics([])).toEqual({});
    const same = forecastMetrics([
      { p: 0, outcome: true, truth: 0.9 },
      { p: 1, outcome: true, truth: 0.8 },
    ]);
    expect(same.skill).toBeUndefined();
    expect(Number.isFinite(same.log_loss)).toBe(true);
    const bins = calibration([
      { p: 0.1, outcome: false, truth: 0.2 },
      { p: 1, outcome: true, truth: 0.9 },
    ]);
    expect(bins.map((b) => [b.from, b.n])).toEqual([
      [0, 1],
      [0.8, 1],
    ]);
    expect(poolCalibration([bins, bins])).toEqual(
      bins.map((b) => ({ ...b, n: 2 })),
    );
  });
});
