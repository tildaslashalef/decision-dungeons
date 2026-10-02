// `bun run eval` and `bun run check`: runs a dungeon headless over seeds
// with one decider, prints a JSON line per run, then a markdown table of
// the same results.
//
//   bun run eval --dungeon driving --level town --decider nuclis --model laya-multilingual --seeds 1-4
//   bun run check driving/stop-line --decider rule
//   bun run eval --dungeon driving --level town --decider random --evaluation

import { parseArgs } from "node:util";
import { type Decider, decideWith } from "../contract/decider.ts";
import {
  createDeciders,
  DECIDE_TIMEOUT_MS,
  isDeciderId,
} from "../deciders/registry.ts";
import { dungeonById, dungeons } from "../dungeons/registry.ts";
import { type RunResult, runEpisode } from "../dungeons/run.ts";
import { ConfigStore, configHome } from "../server/config.ts";

const DEFAULT_MODEL: Record<string, string> = {
  rule: "baseline",
  random: "uniform",
  typesafe: "jev-latest",
  nuclis: "laya-multilingual",
};

const USAGE = `usage:
  bun run eval --dungeon <id> --level <id[,id]> --decider <id> [--model <id>] [--seeds 1-4] [--evaluation] [--json]
  bun run check <dungeon>/<level> --decider <id> [--model <id>] [--seeds 42] [--evaluation] [--json]
--evaluation turns the dungeon's safety nets off (driving: the safety brake and the collision filter)
dungeons: ${Object.values(dungeons)
  .map((d) => `${d.id} (${d.levels.map((l) => l.id).join(", ")})`)
  .join("; ")}`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

/** "1-4", "1,3,7", or "42". */
function seedsFrom(text: string): number[] {
  const seeds = text.split(",").flatMap((part) => {
    const [a, b] = part.split("-").map(Number);
    if (a === undefined || !Number.isSafeInteger(a)) fail(`bad seeds: ${text}`);
    if (b === undefined) return [a];
    if (!Number.isSafeInteger(b) || b < a) fail(`bad seeds: ${text}`);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
  return seeds;
}

const format = (value: number | undefined, digits = 1) =>
  value === undefined
    ? "—"
    : Number.isInteger(value)
      ? String(value)
      : value.toFixed(digits);

function table(results: RunResult[]): string {
  const metrics = [
    ...new Set(results.flatMap((r) => Object.keys(r.outcome.metrics))),
  ];
  const head = [
    "level",
    "seed",
    "result",
    "violations",
    ...metrics,
    "asked",
    "ms/decision",
  ];
  const rows = results.map((r) => [
    r.level,
    String(r.seed),
    r.error
      ? `error: ${r.error.code}`
      : r.outcome.passed === undefined
        ? "unfinished"
        : r.outcome.passed
          ? "pass"
          : "fail",
    String(r.outcome.violations),
    ...metrics.map((m) => format(r.outcome.metrics[m])),
    String(r.asked),
    format(r.meanDecideMs, 0),
  ]);
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join(
    "\n",
  );
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      dungeon: { type: "string" },
      level: { type: "string" },
      decider: { type: "string" },
      model: { type: "string" },
      seeds: { type: "string" },
      evaluation: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  let dungeonId = values.dungeon;
  let levels = values.level?.split(",") ?? [];
  if (command === "check") {
    const [d, l] = (positionals[0] ?? "").split("/");
    if (!d || !l) fail("check takes <dungeon>/<level>");
    dungeonId = d;
    levels = [l];
  }
  const dungeon =
    dungeonById(dungeonId ?? "") ??
    fail(`unknown dungeon ${dungeonId ?? "(none)"}`);
  if (!levels.length) levels = dungeon.levels.map((l) => l.id);
  for (const level of levels)
    if (!dungeon.levels.some((l) => l.id === level))
      fail(`${dungeon.id} has no level ${level}`);
  const deciderId = values.decider ?? fail("--decider is required");
  if (!isDeciderId(deciderId)) fail(`unknown decider ${deciderId}`);
  const model = values.model ?? (DEFAULT_MODEL[deciderId] as string);
  const seeds = seedsFrom(values.seeds ?? (command === "check" ? "42" : "1-4"));
  if (values.evaluation && !dungeon.evaluation)
    fail(`${dungeon.id} has no evaluation mode`);

  const env = process.env;
  const store = new ConfigStore(configHome(env), env);
  const decider: Decider =
    deciderId === "rule"
      ? dungeon.rule
      : createDeciders(store.effective(await store.load()))[deciderId];
  const results: RunResult[] = [];
  for (const level of levels)
    for (const seed of seeds) {
      const result = await runEpisode(
        dungeon,
        level,
        seed,
        { id: deciderId, model },
        (request) =>
          decideWith(decider, request, {
            model,
            seed,
            signal: AbortSignal.timeout(DECIDE_TIMEOUT_MS[deciderId]),
          }),
        { evaluation: values.evaluation },
      );
      results.push(result);
      console.log(JSON.stringify(result));
    }
  if (!values.json)
    console.log(
      `\n${dungeon.title} · ${deciderId} · ${model}${values.evaluation ? " · evaluation mode" : ""}\n\n${table(results)}`,
    );
  if (results.some((r) => r.error || r.outcome.passed === false))
    process.exitCode = 1;
}

await main(process.argv.slice(2));
