// The text dungeons' case sets, in SQLite (`dungeons.db` in the config
// home, mode 600). A set is written once from a seeded generator and never
// edited: more cases means a new set, so a result's set name and hash
// always name the cases it played. The `base` set of each dungeon is
// written on first use, exactly as `bun run seed` writes it. Server and
// CLI only (bun:sqlite).

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { INBOX_GENERATOR, inboxCases } from "../dungeons/inbox/generate.ts";
import { LOGS_GENERATOR, logCases } from "../dungeons/logs/generate.ts";
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
    base: { phishing: 120, triage: 100, languages: 80, long: 60 },
    generate: inboxCases,
  },
  tickets: {
    id: TICKETS_GENERATOR,
    base: { routing: 100, urgency: 100, refunds: 80, languages: 80 },
    generate: ticketCases,
  },
  logs: {
    id: LOGS_GENERATOR,
    base: { incident: 100, thresholds: 100, "root-cause": 80, long: 60 },
    generate: logCases,
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
      JSON.stringify([c.id, c.level, c.lang, c.input, c.truth, c.why]),
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
}

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

  constructor(readonly home: string) {
    this.file = join(home, DB_FILE);
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
            "SELECT id, level, lang, input, truth, why FROM cases WHERE dungeon = ? AND set_name = ? AND level = ? ORDER BY id",
          )
          .all(dungeon, name, level)
      : db
          .query<CaseRow, [string, string]>(
            "SELECT id, level, lang, input, truth, why FROM cases WHERE dungeon = ? AND set_name = ? ORDER BY id",
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
      })),
    };
  }

  /**
   * Stores a set. An existing set of the same name is left alone when its
   * hash matches, refused when it differs, unless `replace`.
   */
  write(set: CaseSet, replace = false): "written" | "unchanged" | "replaced" {
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
        "INSERT INTO cases (dungeon, set_name, id, level, lang, input, truth, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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
        );
    })();
    return existing ? "replaced" : "written";
  }

  /** Writes each text dungeon's base set if it is missing. */
  ensureBase(): void {
    for (const [dungeon, generator] of Object.entries(GENERATORS))
      if (!this.list(dungeon).some((s) => s.name === BASE_SET))
        this.write(buildSet(dungeon, BASE_SET, BASE_SEED, generator.base));
  }
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
