import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideWith } from "../src/contract/decider.ts";
import { parseRequest, validateAnswers } from "../src/contract/validate.ts";
import { randomDecider } from "../src/deciders/random.ts";
import type { AnyDungeon } from "../src/dungeons/dungeon.ts";
import { dungeonById } from "../src/dungeons/registry.ts";
import { runEpisode } from "../src/dungeons/run.ts";
import { type CaseSet, pickCases } from "../src/dungeons/text/cases.ts";
import type { TextRun } from "../src/dungeons/text/text-dungeon.ts";
import {
  BASE_SEED,
  buildSet,
  CaseError,
  CaseStore,
  GENERATORS,
} from "../src/server/cases.ts";

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dd-cases-"));
  homes.push(home);
  return home;
}

const sets: Record<string, CaseSet> = Object.fromEntries(
  Object.entries(GENERATORS).map(([id, g]) => [
    id,
    buildSet(id, "base", BASE_SEED, g.base),
  ]),
);
const setOf = (id: string): CaseSet => {
  const set = sets[id];
  if (!set) throw new Error(`no ${id} set`);
  return set;
};

describe("case generators", () => {
  test("the same seed writes the same cases; another seed does not", () => {
    for (const [id, g] of Object.entries(GENERATORS)) {
      const again = buildSet(id, "base", BASE_SEED, g.base);
      expect(again.hash).toBe(sets[id]?.hash as string);
      expect(buildSet(id, "base", 2, g.base).hash).not.toBe(again.hash);
    }
  });

  test("every case is a valid request whose known answers fit its questions", () => {
    for (const [id, set] of Object.entries(sets)) {
      const dungeon = dungeonById(id) as AnyDungeon;
      expect(new Set(set.cases.map((c) => c.id)).size).toBe(set.cases.length);
      for (const level of dungeon.levels) {
        const run = dungeon.create(1, level.id, { cases: set }) as TextRun;
        expect(run.cases.length).toBe(20);
        for (const c of set.cases.filter((x) => x.level === level.id)) {
          const { request } = dungeon.observe({ ...run, cases: [c], index: 0 });
          expect(() => parseRequest(request)).not.toThrow();
          for (const [q, truth] of Object.entries(c.truth)) {
            const question = request.questions[q];
            expect(question).toBeDefined();
            if (question?.type === "noul") expect(typeof truth).toBe("boolean");
            if (question?.type === "choice")
              expect(Object.keys(question.criteria)).toContain(truth as string);
            if (question?.type === "score")
              expect(truth as number).toBeLessThan(question.criteria.length);
          }
        }
      }
    }
  });

  test("labels are balanced where a level is a yes-or-no question", () => {
    for (const [id, level, q] of [
      ["inbox", "phishing", "phishing"],
      ["inbox", "long", "phishing"],
      ["logs", "incident", "page"],
      ["logs", "thresholds", "breach"],
    ] as const) {
      const cases = (sets[id]?.cases ?? []).filter((c) => c.level === level);
      const yes =
        cases.filter((c) => c.truth[q] === true).length / cases.length;
      expect(yes).toBeGreaterThan(0.3);
      expect(yes).toBeLessThan(0.7);
    }
  });

  test("a seed picks the same cases from a set, and different seeds differ", () => {
    const set = sets.inbox;
    if (!set) throw new Error("no inbox set");
    const a = pickCases(set, "phishing", 3, 20).map((c) => c.id);
    expect(pickCases(set, "phishing", 3, 20).map((c) => c.id)).toEqual(a);
    expect(pickCases(set, "phishing", 4, 20).map((c) => c.id)).not.toEqual(a);
  });
});

describe("text dungeons", () => {
  test("the rules answer validly and pass their home levels", async () => {
    for (const [id, level] of [
      ["inbox", "phishing"],
      ["tickets", "refunds"],
      ["logs", "thresholds"],
    ] as const) {
      const dungeon = dungeonById(id) as AnyDungeon;
      const result = await runEpisode(
        dungeon,
        level,
        1,
        { id: "rule", model: "baseline" },
        async (request) => {
          const decision = await decideWith(dungeon.rule, request, {
            model: "baseline",
            signal: AbortSignal.timeout(1000),
          });
          expect(() =>
            validateAnswers(request, decision.answers),
          ).not.toThrow();
          return decision;
        },
        { cases: setOf(id) },
      );
      expect(result.outcome.passed).toBe(true);
      expect(result.caseSet).toEqual({ name: "base", hash: setOf(id).hash });
    }
  });

  test("random is scored, records its set, and a run needs a set", async () => {
    const dungeon = dungeonById("tickets") as AnyDungeon;
    const result = await runEpisode(
      dungeon,
      "routing",
      2,
      { id: "random", model: "uniform" },
      (request) =>
        decideWith(randomDecider(), request, {
          model: "uniform",
          seed: 2,
          signal: AbortSignal.timeout(1000),
        }),
      { cases: setOf("tickets") },
    );
    expect(result.outcome.finished).toBe(true);
    expect(result.outcome.metrics.accuracy).toBeLessThan(0.6);
    expect(() => dungeon.create(1, "routing")).toThrow("bun run seed");
  });
});

describe("case store", () => {
  test("writes once, refuses a different set under the same name, replaces when told", () => {
    const store = new CaseStore(newHome());
    const set = buildSet("logs", "extra", 7, { thresholds: 30 });
    expect(store.write(set)).toBe("written");
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(store.write(set)).toBe("unchanged");
    const other = buildSet("logs", "extra", 8, { thresholds: 30 });
    expect(() => store.write(other)).toThrow(CaseError);
    expect(store.write(other, true)).toBe("replaced");
    const loaded = store.load("logs", "extra");
    expect(loaded?.hash).toBe(other.hash);
    expect(loaded?.cases).toEqual(other.cases);
    expect(() => store.write({ ...set, name: "Bad Name" })).toThrow(CaseError);
    store.close();
  });

  test("writes every base set on first use, and loads one level", () => {
    const store = new CaseStore(newHome());
    store.ensureBase();
    expect(store.list("inbox").map((s) => s.name)).toEqual(["base"]);
    const long = store.load("inbox", "base", "long");
    expect(long?.cases.every((c) => c.level === "long")).toBe(true);
    expect(long?.hash).toBe(sets.inbox?.hash as string);
    store.close();
  });
});
