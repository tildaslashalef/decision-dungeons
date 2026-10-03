// The text dungeons' case sets, in SQLite (`dungeons.db` in the config
// home, mode 600). A set is written once from a seeded generator, and its
// stored cases never change: it may only gain whole new levels, so a run
// of a level always plays the cases it played before. The `base` set of
// each dungeon is written on first use, exactly as `bun run seed` writes
// it. Cases with a picture are rendered from their source before they are
// stored. Server and CLI only (bun:sqlite).

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { INBOX_GENERATOR, inboxCases } from "../dungeons/inbox/generate.ts";
import { LOGS_GENERATOR, logCases } from "../dungeons/logs/generate.ts";
import { ORACLE_GENERATOR, oracleCases } from "../dungeons/oracle/generate.ts";
import {
  RECEIPTS_GENERATOR,
  receiptCases,
} from "../dungeons/receipts/generate.ts";
import type { CaseSet, CaseSetInfo, TextCase } from "../dungeons/text/cases.ts";
import {
  TICKETS_GENERATOR,
  ticketCases,
} from "../dungeons/tickets/generate.ts";

export const DB_FILE = "dungeons.db";
export const BASE_SET = "base";
export const BASE_SEED = 1;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface Generator {
  id: string;
  /** Cases per level in a base set. */
  base: Record<string, number>;
  generate(level: string, count: number, seed: number): TextCase[];
}

export const GENERATORS: Record<string, Generator> = {
  inbox: {
    id: INBOX_GENERATOR,
    base: {
      phishing: 120,
      triage: 100,
      languages: 80,
      long: 60,
      "all-questions": 60,
    },
    generate: inboxCases,
  },
  tickets: {
    id: TICKETS_GENERATOR,
    base: {
      routing: 100,
      urgency: 100,
      refunds: 80,
      languages: 80,
      "all-questions": 60,
    },
    generate: ticketCases,
  },
  logs: {
    id: LOGS_GENERATOR,
    base: {
      incident: 100,
      thresholds: 100,
      "root-cause": 80,
      long: 60,
      "all-questions": 60,
    },
    generate: logCases,
  },
  receipts: {
    id: RECEIPTS_GENERATOR,
    base: { "policy-text": 60, total: 40, "all-questions": 40 },
    generate: receiptCases,
  },
  oracle: {
    id: ORACLE_GENERATOR,
    base: { numbers: 120, many: 80 },
    generate: oracleCases,
  },
};

export class CaseError extends Error {
  override readonly name = "CaseError";
}

/** A digest of the cases' content, in id order: equal sets hash equal. */
export function caseHash(cases: TextCase[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const c of [...cases].sort((a, b) => (a.id < b.id ? -1 : 1)))
    hasher.update(
      JSON.stringify([
        c.id,
        c.level,
        c.lang,
        c.input,
        c.truth,
        c.why,
        // Only when present, so sets without them keep their hashes.
        ...(c.source ? [c.source] : []),
        ...(c.odds ? [{ odds: c.odds }] : []),
      ]),
    );
  return hasher.digest("hex").slice(0, 16);
}

/** Writes the cases of one set from its generator; pure apart from the hash. */
export function buildSet(
  dungeon: string,
  name: string,
  seed: number,
  levels: Record<string, number>,
): CaseSet {
  const generator = GENERATORS[dungeon];
  if (!generator) throw new CaseError(`${dungeon} has no case generator`);
  for (const level of Object.keys(levels))
    if (!Object.hasOwn(generator.base, level))
      throw new CaseError(`${dungeon} has no level ${level}`);
  const cases = Object.entries(levels).flatMap(([level, count]) =>
    generator.generate(level, count, seed),
  );
  return {
    dungeon,
    name,
    generator: generator.id,
    seed,
    count: cases.length,
    hash: caseHash(cases),
    levels,
    cases,
  };
}

interface SetRow {
  dungeon: string;
  name: string;
  generator: string;
  seed: number;
  count: number;
  hash: string;
  levels: string;
}

interface CaseRow {
  id: string;
  level: string;
  lang: string;
  input: string;
  truth: string;
  why: string;
  source: string | null;
  images: string | null;
  odds: string | null;
}

/** Fills each case's `images` from its `source`. */
export type Renderer = (cases: TextCase[]) => Promise<TextCase[]>;

/** Headless Chromium, loaded only when a set has pictures to render. */
const chromiumRenderer: Renderer = async (cases) =>
  (await import("./render.ts")).renderCases(cases);

/**
 * Tuned for this store's use: read often (the server, every eval), written
 * rarely and in bulk (`bun run seed`, a base set on first use), sometimes
 * by two processes at once. WAL lets readers and the writer proceed
 * together; NORMAL sync is durable under WAL short of power loss, and a
 * lost seed can be rewritten exactly; a busy timeout covers the moment both
 * touch the file; reads come through a 16 MB cache and memory mapping.
 */
const PRAGMAS = [
  "journal_mode = WAL",
  "synchronous = NORMAL",
  "busy_timeout = 5000",
  "foreign_keys = ON",
  "temp_store = MEMORY",
  "cache_size = -16000",
  "mmap_size = 268435456",
  "journal_size_limit = 67108864",
];

/** The schema by version (`PRAGMA user_version`); each step runs once, in a transaction. */
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS case_sets (
      dungeon TEXT NOT NULL,
      name TEXT NOT NULL,
      generator TEXT NOT NULL,
      seed INTEGER NOT NULL,
      count INTEGER NOT NULL,
      hash TEXT NOT NULL,
      levels TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (dungeon, name)
    )`,
    `CREATE TABLE IF NOT EXISTS cases (
      dungeon TEXT NOT NULL,
      set_name TEXT NOT NULL,
      id TEXT NOT NULL,
      level TEXT NOT NULL,
      lang TEXT NOT NULL,
      input TEXT NOT NULL,
      truth TEXT NOT NULL,
      why TEXT NOT NULL,
      PRIMARY KEY (dungeon, set_name, id),
      FOREIGN KEY (dungeon, set_name) REFERENCES case_sets (dungeon, name) ON DELETE CASCADE
    )`,
    // Serves "one level of a set, by id" without a sort. IF NOT EXISTS and
    // the DROP adopt a file written before the schema had a version.
    "DROP INDEX IF EXISTS cases_by_level",
    "CREATE INDEX IF NOT EXISTS cases_by_level_id ON cases (dungeon, set_name, level, id)",
  ],
  [
    "ALTER TABLE cases ADD COLUMN source TEXT",
    "ALTER TABLE cases ADD COLUMN images TEXT",
  ],
  ["ALTER TABLE cases ADD COLUMN odds TEXT"],
];

function migrate(db: Database): void {
  const version =
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()
      ?.user_version ?? 0;
  if (version > MIGRATIONS.length)
    throw new CaseError(
      `${DB_FILE} has schema version ${version}, newer than this build knows (${MIGRATIONS.length})`,
    );
  db.transaction(() => {
    for (let v = version; v < MIGRATIONS.length; v++)
      for (const sql of MIGRATIONS[v] ?? []) db.run(sql);
    db.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
  }).immediate();
}

export class CaseStore {
  readonly file: string;
  private db: Database | null = null;

  private readonly renderer: Renderer;
  private basing: Promise<void> | null = null;

  constructor(
    readonly home: string,
    options: { render?: Renderer } = {},
  ) {
    this.file = join(home, DB_FILE);
    this.renderer = options.render ?? chromiumRenderer;
  }

  /** `set` with every pictured case's images rendered from its source. */
  async rendered(set: CaseSet): Promise<CaseSet> {
    const missing = set.cases.filter((c) => c.source && !c.images);
    if (!missing.length) return set;
    const done = new Map(
      (await this.renderer(missing)).map((c) => [c.id, c.images]),
    );
    return {
      ...set,
      cases: set.cases.map((c) => {
        const images = done.get(c.id);
        return images ? { ...c, images } : c;
      }),
    };
  }

  private open(): Database {
    if (this.db) return this.db;
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const db = new Database(this.file, { create: true, strict: true });
    // The -wal and -shm files take the database file's mode.
    chmodSync(this.file, 0o600);
    for (const pragma of PRAGMAS) db.run(`PRAGMA ${pragma}`);
    migrate(db);
    this.db = db;
    return db;
  }

  /** Lets SQLite refresh its planner statistics, then closes; the WAL is checkpointed on close. */
  close(): void {
    if (!this.db) return;
    this.db.run("PRAGMA optimize");
    this.db.close();
    this.db = null;
  }

  list(dungeon: string): CaseSetInfo[] {
    return this.open()
      .query<SetRow, [string]>(
        "SELECT dungeon, name, generator, seed, count, hash, levels FROM case_sets WHERE dungeon = ? ORDER BY name",
      )
      .all(dungeon)
      .map(info);
  }

  /** One set; with `level`, only that level's cases (the hash still names the whole set). */
  load(dungeon: string, name: string, level?: string): CaseSet | null {
    const db = this.open();
    const row = db
      .query<SetRow, [string, string]>(
        "SELECT dungeon, name, generator, seed, count, hash, levels FROM case_sets WHERE dungeon = ? AND name = ?",
      )
      .get(dungeon, name);
    if (!row) return null;
    const rows = level
      ? db
          .query<CaseRow, [string, string, string]>(
            "SELECT id, level, lang, input, truth, why, source, images, odds FROM cases WHERE dungeon = ? AND set_name = ? AND level = ? ORDER BY id",
          )
          .all(dungeon, name, level)
      : db
          .query<CaseRow, [string, string]>(
            "SELECT id, level, lang, input, truth, why, source, images, odds FROM cases WHERE dungeon = ? AND set_name = ? ORDER BY id",
          )
          .all(dungeon, name);
    return {
      ...info(row),
      cases: rows.map((r) => ({
        id: r.id,
        level: r.level,
        lang: r.lang,
        input: JSON.parse(r.input),
        truth: JSON.parse(r.truth),
        why: r.why,
        ...(r.source ? { source: JSON.parse(r.source) } : {}),
        ...(r.images ? { images: JSON.parse(r.images) } : {}),
        ...(r.odds ? { odds: JSON.parse(r.odds) } : {}),
      })),
    };
  }

  /**
   * Stores a set. An existing set of the same name is left alone when its
   * hash matches, and grows when the new set holds every one of its levels
   * case for case and adds levels (a run of an old level plays exactly what
   * it played before). Anything else is refused, unless `replace`.
   */
  write(
    set: CaseSet,
    replace = false,
  ): "written" | "unchanged" | "extended" | "replaced" {
    if (!NAME.test(set.name))
      throw new CaseError(
        "a set name is lower-case letters, digits, dots, dashes, or underscores",
      );

    const db = this.open();
    const existing = db
      .query<{ hash: string }, [string, string]>(
        "SELECT hash FROM case_sets WHERE dungeon = ? AND name = ?",
      )
      .get(set.dungeon, set.name);
    if (existing?.hash === set.hash) return "unchanged";
    if (existing && !replace && this.extend(set)) return "extended";
    unrendered(set, set.cases);
    if (existing && !replace)
      throw new CaseError(
        `${set.dungeon} already has a set named ${set.name} with other cases; choose another name or --replace it`,
      );
    db.transaction(() => {
      db.run("DELETE FROM case_sets WHERE dungeon = ? AND name = ?", [
        set.dungeon,
        set.name,
      ]);
      db.run(
        "INSERT INTO case_sets (dungeon, name, generator, seed, count, hash, levels, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          set.dungeon,
          set.name,
          set.generator,
          set.seed,
          set.count,
          set.hash,
          JSON.stringify(set.levels),
          new Date().toISOString(),
        ],
      );
      const insert = db.prepare(
        "INSERT INTO cases (dungeon, set_name, id, level, lang, input, truth, why, source, images, odds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const c of set.cases)
        insert.run(
          set.dungeon,
          set.name,
          c.id,
          c.level,
          c.lang,
          JSON.stringify(c.input),
          JSON.stringify(c.truth),
          c.why,
          c.source ? JSON.stringify(c.source) : null,
          c.images ? JSON.stringify(c.images) : null,
          c.odds ? JSON.stringify(c.odds) : null,
        );
    })();
    return existing ? "replaced" : "written";
  }

  /**
   * Adds the levels `set` has beyond the stored set of its name, when every
   * stored level is in `set` with the same cases; false, writing nothing,
   * otherwise.
   */
  private extend(set: CaseSet): boolean {
    const stored = this.load(set.dungeon, set.name);
    if (!stored) return false;
    const ofLevel = (cases: TextCase[], level: string) =>
      cases.filter((c) => c.level === level);
    const added = Object.keys(set.levels).filter(
      (level) => !Object.hasOwn(stored.levels, level),
    );
    if (
      !added.length ||
      Object.keys(stored.levels).some(
        (level) =>
          !Object.hasOwn(set.levels, level) ||
          caseHash(ofLevel(stored.cases, level)) !==
            caseHash(ofLevel(set.cases, level)),
      )
    )
      return false;
    unrendered(
      set,
      set.cases.filter((c) => added.includes(c.level)),
    );
    const db = this.open();
    db.transaction(() => {
      db.run(
        "UPDATE case_sets SET generator = ?, count = ?, hash = ?, levels = ? WHERE dungeon = ? AND name = ?",
        [
          set.generator,
          set.count,
          set.hash,
          JSON.stringify(set.levels),
          set.dungeon,
          set.name,
        ],
      );
      const insert = db.prepare(
        "INSERT INTO cases (dungeon, set_name, id, level, lang, input, truth, why, source, images, odds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const c of set.cases)
        if (added.includes(c.level))
          insert.run(
            set.dungeon,
            set.name,
            c.id,
            c.level,
            c.lang,
            JSON.stringify(c.input),
            JSON.stringify(c.truth),
            c.why,
            c.source ? JSON.stringify(c.source) : null,
            c.images ? JSON.stringify(c.images) : null,
            c.odds ? JSON.stringify(c.odds) : null,
          );
    })();
    return true;
  }

  /**
   * Writes each text dungeon's base set if it is missing, and adds to it
   * the generator's levels it lacks, keeping its stored levels' counts.
   * Concurrent callers share one pass.
   */
  ensureBase(): Promise<void> {
    this.basing ??= this.writeBase().finally(() => {
      this.basing = null;
    });
    return this.basing;
  }

  private async writeBase(): Promise<void> {
    for (const [dungeon, generator] of Object.entries(GENERATORS)) {
      const stored = this.list(dungeon).find((s) => s.name === BASE_SET);
      const levels = stored
        ? { ...generator.base, ...stored.levels }
        : generator.base;
      if (
        stored &&
        Object.keys(generator.base).every((l) =>
          Object.hasOwn(stored.levels, l),
        )
      )
        continue;
      const set = buildSet(
        dungeon,
        BASE_SET,
        stored?.seed ?? BASE_SEED,
        levels,
      );
      // Render only the cases this write will add.
      const adding = stored
        ? set.cases.filter((c) => !Object.hasOwn(stored.levels, c.level))
        : set.cases;
      const rendered = await this.rendered({ ...set, cases: adding });
      const byId = new Map(rendered.cases.map((c) => [c.id, c]));
      this.write({ ...set, cases: set.cases.map((c) => byId.get(c.id) ?? c) });
    }
  }
}

/** Refuses to store pictured cases without their rendered images. */
function unrendered(set: CaseSet, cases: TextCase[]): void {
  if (cases.some((c) => c.source && !c.images))
    throw new CaseError(
      `${set.dungeon}/${set.name} has pictures not yet rendered (CaseStore.rendered)`,
    );
}

function info(row: SetRow): CaseSetInfo {
  return {
    dungeon: row.dungeon,
    name: row.name,
    generator: row.generator,
    seed: row.seed,
    count: row.count,
    hash: row.hash,
    levels: JSON.parse(row.levels),
  };
}
