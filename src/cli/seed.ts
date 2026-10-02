// `bun run seed`: writes text dungeons' case sets into dungeons.db in the
// config home. With no arguments, each dungeon's base set (the server also
// writes it on first use). A set is immutable: generate more cases under a
// new name, or rewrite one with --replace (results that played it keep the
// old hash, so they no longer match it).
//
//   bun run seed
//   bun run seed --dungeon inbox --set more --seed 7 --count 400
//   bun run seed --dungeon logs --set thresholds-hard --seed 3 --level thresholds=500
//   bun run seed --list

import { parseArgs } from "node:util";
import {
  BASE_SEED,
  BASE_SET,
  buildSet,
  CaseError,
  CaseStore,
  GENERATORS,
} from "../server/cases.ts";
import { configHome } from "../server/config.ts";

const USAGE = `usage:
  bun run seed                                   the base set of every text dungeon
  bun run seed --dungeon <id> --set <name> [--seed <n>] [--count <n> | --level <id>=<n>[,<id>=<n>]] [--replace]
  bun run seed --list
text dungeons: ${Object.entries(GENERATORS)
  .map(([id, g]) => `${id} (${Object.keys(g.base).join(", ")})`)
  .join("; ")}`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

/** `--count n` spreads n over the levels in the base proportions; `--level a=n,b=m` names them. */
function levelCounts(
  dungeon: string,
  count: string | undefined,
  level: string | undefined,
): Record<string, number> {
  const base = GENERATORS[dungeon]?.base ?? {};
  if (level) {
    const out: Record<string, number> = {};
    for (const part of level.split(",")) {
      const [id, n] = part.split("=");
      const value = Number(n);
      if (!id || !Number.isSafeInteger(value) || value < 1 || value > 100_000)
        fail(`bad --level ${part}`);
      out[id] = value;
    }
    return out;
  }
  if (!count) return base;
  const total = Number(count);
  if (!Number.isSafeInteger(total) || total < 1 || total > 1_000_000)
    fail(`bad --count ${count}`);
  const sum = Object.values(base).reduce((a, b) => a + b, 0);
  return Object.fromEntries(
    Object.entries(base).map(([id, n]) => [
      id,
      Math.max(1, Math.round((total * n) / sum)),
    ]),
  );
}

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      dungeon: { type: "string" },
      set: { type: "string" },
      seed: { type: "string" },
      count: { type: "string" },
      level: { type: "string" },
      replace: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
    },
  });
  const store = new CaseStore(configHome(process.env));
  try {
    if (values.list) {
      for (const dungeon of Object.keys(GENERATORS))
        for (const s of store.list(dungeon))
          console.log(
            `${dungeon}/${s.name}  ${s.count} cases  seed ${s.seed}  ${s.generator}  ${s.hash}  ${Object.entries(
              s.levels,
            )
              .map(([l, n]) => `${l} ${n}`)
              .join(", ")}`,
          );
      return;
    }
    const dungeons = values.dungeon
      ? [values.dungeon]
      : Object.keys(GENERATORS);
    for (const dungeon of dungeons) {
      if (!GENERATORS[dungeon]) fail(`no text dungeon ${dungeon}`);
      const name = values.set ?? BASE_SET;
      const seed = values.seed === undefined ? BASE_SEED : Number(values.seed);
      if (!Number.isSafeInteger(seed) || seed < 0)
        fail(`bad --seed ${values.seed}`);
      const started = performance.now();
      const set = buildSet(
        dungeon,
        name,
        seed,
        levelCounts(dungeon, values.count, values.level),
      );
      const result = store.write(set, values.replace);
      console.log(
        `${dungeon}/${name}: ${result}, ${set.count} cases, hash ${set.hash} (${Math.round(performance.now() - started)} ms) in ${store.file}`,
      );
    }
  } catch (error) {
    if (error instanceof CaseError) fail(error.message);
    throw error;
  } finally {
    store.close();
  }
}

main(process.argv.slice(2));
