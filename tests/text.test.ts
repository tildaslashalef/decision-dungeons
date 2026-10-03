import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideWith } from "../src/contract/decider.ts";
import type { Request } from "../src/contract/request.ts";
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
import { fakeRender, TINY_PNG } from "./fake-render.ts";

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
const ids = { id: "random", model: "uniform" };
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

describe("batched runs", () => {
  test("play the same run as one case at a time, in fewer calls", async () => {
    const dungeon = dungeonById("inbox") as AnyDungeon;
    const decide = (request: Request) =>
      decideWith(randomDecider(), request, {
        model: "uniform",
        seed: 5,
        signal: AbortSignal.timeout(1000),
      });
    const one = await runEpisode(dungeon, "triage", 5, ids, decide, {
      cases: setOf("inbox"),
    });
    let calls = 0;
    const many = await runEpisode(
      dungeon,
      "triage",
      5,
      ids,
      decide,
      { cases: setOf("inbox") },
      async (requests) => {
        calls++;
        return Promise.all(requests.map(decide));
      },
    );
    expect(calls).toBe(1);
    expect(many.batched).toBe(true);
    expect(many.outcome).toEqual(one.outcome);
  });
});

describe("case store", () => {
  test("writes once, refuses a different set under the same name, replaces when told", () => {
    const store = new CaseStore(newHome(), { render: fakeRender });
    const set = buildSet("logs", "extra", 7, { thresholds: 30 });
    expect(store.write(set)).toBe("written");
    for (const file of [store.file, `${store.file}-wal`, `${store.file}-shm`])
      expect(statSync(file).mode & 0o777).toBe(0o600);
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

  test("a set grows by new levels only, keeping every stored case", async () => {
    const store = new CaseStore(newHome(), { render: fakeRender });
    const { "all-questions": _added, ...older } = (
      GENERATORS.tickets as (typeof GENERATORS)[string]
    ).base;
    const before = buildSet("tickets", "base", BASE_SEED, older);
    expect(store.write(before)).toBe("written");
    // A changed stored level is still refused.
    const changed = buildSet("tickets", "base", BASE_SEED, {
      ...older,
      routing: 10,
      "all-questions": 5,
    });
    expect(() => store.write(changed)).toThrow(CaseError);
    await store.ensureBase();
    const grown = store.load("tickets", "base");
    expect(grown?.hash).toBe(setOf("tickets").hash);
    expect(grown?.levels["all-questions"]).toBe(60);
    const byId = (a: { id: string }, b: { id: string }) =>
      a.id < b.id ? -1 : 1;
    expect(grown?.cases.filter((c) => c.level !== "all-questions")).toEqual(
      [...before.cases].sort(byId),
    );
    expect(store.write(setOf("tickets"))).toBe("unchanged");
    store.close();
  });

  test("a many-questions level asks every question it scores", () => {
    for (const [id, set] of Object.entries(sets)) {
      const dungeon = dungeonById(id) as AnyDungeon;
      const level = dungeon.levels.find((l) =>
        l.tags?.includes("many-questions"),
      );
      if (!level) throw new Error(`${id} has no many-questions level`);
      const run = dungeon.create(1, level.id, { cases: set });
      const asked = Object.keys(dungeon.observe(run).request.questions);
      expect(asked.length).toBeGreaterThan(1);
      for (const c of set.cases.filter((c) => c.level === level.id))
        expect(Object.keys(c.truth).sort()).toEqual([...asked].sort());
    }
  });

  test("runs in WAL mode, versioned, and reads while another process writes", async () => {
    const home = newHome();
    const store = new CaseStore(home, { render: fakeRender });
    await store.ensureBase();
    const db = new Database(store.file, { readonly: true });
    expect(db.query("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    db.close();
    // A seed in another process while this one reads: neither waits on the other.
    const writer = Bun.spawn(
      [
        "bun",
        "src/cli/seed.ts",
        "--dungeon",
        "logs",
        "--set",
        "busy",
        "--seed",
        "9",
        "--level",
        "thresholds=2000",
      ],
      {
        env: { ...process.env, DECISION_DUNGEONS_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let reads = 0;
    while (writer.exitCode === null) {
      expect(store.load("inbox", "base", "phishing")?.cases.length).toBe(120);
      reads++;
      await Bun.sleep(1);
    }
    expect(await writer.exited).toBe(0);
    expect(reads).toBeGreaterThan(0);
    expect(store.list("logs").map((s) => s.name)).toEqual(["base", "busy"]);
    store.close();
  });

  test("adopts a file written before the schema had a version", async () => {
    const home = newHome();
    const old = new Database(join(home, "dungeons.db"), { create: true });
    old.run(
      "CREATE TABLE case_sets (dungeon TEXT NOT NULL, name TEXT NOT NULL, generator TEXT NOT NULL, seed INTEGER NOT NULL, count INTEGER NOT NULL, hash TEXT NOT NULL, levels TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (dungeon, name))",
    );
    old.run(
      "CREATE TABLE cases (dungeon TEXT NOT NULL, set_name TEXT NOT NULL, id TEXT NOT NULL, level TEXT NOT NULL, lang TEXT NOT NULL, input TEXT NOT NULL, truth TEXT NOT NULL, why TEXT NOT NULL, PRIMARY KEY (dungeon, set_name, id))",
    );
    old.run("CREATE INDEX cases_by_level ON cases (dungeon, set_name, level)");
    old.close();
    const store = new CaseStore(home, { render: fakeRender });
    await store.ensureBase();
    expect(store.load("logs", "base", "long")?.cases.length).toBe(60);
    store.close();
  });

  test("writes every base set on first use, and loads one level", async () => {
    const store = new CaseStore(newHome(), { render: fakeRender });
    await store.ensureBase();
    expect(store.list("inbox").map((s) => s.name)).toEqual(["base"]);
    const long = store.load("inbox", "base", "long");
    expect(long?.cases.every((c) => c.level === "long")).toBe(true);
    expect(long?.hash).toBe(sets.inbox?.hash as string);
    store.close();
  });
});

describe("receipts", () => {
  test("the same receipts as text, picture, or both, the picture only where the level shows it", async () => {
    const store = new CaseStore(newHome(), { render: fakeRender });
    await store.ensureBase();
    const set = store.load("receipts", "base") as CaseSet;
    expect(set.cases.every((c) => c.source && c.images?.[0] === TINY_PNG)).toBe(
      true,
    );
    const dungeon = dungeonById("receipts") as AnyDungeon;
    const asked = (level: string) => {
      const run = dungeon.create(3, level, { cases: set }) as TextRun;
      return { run, request: dungeon.observe(run).request };
    };
    const text = asked("policy-text");
    const image = asked("policy-image");
    const both = asked("policy-both");
    expect(image.run.cases.map((c) => c.id)).toEqual(
      text.run.cases.map((c) => c.id),
    );
    expect(text.request.images).toBeUndefined();
    expect(image.request.images).toEqual([TINY_PNG]);
    expect(typeof image.request.state).toBe("string");
    expect(both.request.images).toEqual([TINY_PNG]);
    expect(both.request.state).toEqual(text.request.state);
    // Every request is valid at the server's boundary, images included.
    expect(parseRequest(JSON.parse(JSON.stringify(image.request)))).toEqual(
      image.request,
    );
    // The total question offers the case's own four totals, the truth among them.
    const total = asked("total");
    const q = total.request.questions.total;
    const c = total.run.cases[0];
    expect(q?.type === "choice" && Object.keys(q.criteria)).toHaveLength(4);
    expect(q?.type === "choice" && Object.keys(q.criteria)).toContain(
      String(c?.truth.total),
    );
    store.close();
  });

  test("the rule applies the policy to the data and cannot see a picture", async () => {
    const dungeon = dungeonById("receipts") as AnyDungeon;
    const set = setOf("receipts");
    for (const seed of [1, 2, 3]) {
      const result = await runEpisode(
        dungeon,
        "policy-text",
        seed,
        { id: "rule", model: "baseline" },
        (request) =>
          decideWith(dungeon.rule, request, {
            model: "baseline",
            signal: AbortSignal.timeout(1000),
          }),
        { cases: set },
      );
      expect(result.outcome.metrics.accuracy).toBe(1);
    }
    const run = dungeon.create(1, "policy-image", { cases: set });
    await expect(
      decideWith(dungeon.rule, dungeon.observe(run).request, {
        model: "baseline",
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toMatchObject({ code: "rejected" });
  });
});
