import { describe, expect, test } from "bun:test";
import type { DeciderView } from "../src/contract/api.ts";
import { defaultAutopilot } from "../src/ui/autopilot.ts";

const view = (id: string, models: string[], reachable = true): DeciderView => ({
  id,
  label: id,
  status: { configured: true, reachable },
  models: models.map((m) => ({ id: m, label: m, available: true })),
});

describe("the default autopilot", () => {
  const up = [
    view("nuclis", ["laya", "laya-multilingual"]),
    view("typesafe", ["jev-latest"]),
    view("rule", ["baseline"]),
    view("random", ["uniform"]),
  ];

  test("is nuclis · laya-multilingual when it is ready", () => {
    expect(defaultAutopilot(up)).toEqual({
      decider: "nuclis",
      model: "laya-multilingual",
    });
  });

  test("gives way to the dungeon's saved default", () => {
    expect(
      defaultAutopilot(up, { decider: "rule", model: "baseline" }),
    ).toEqual({
      decider: "rule",
      model: "baseline",
    });
  });

  test("falls back to the first ready decider when nuclis is down", () => {
    const down = up.map((v) =>
      v.id === "nuclis" ? view("nuclis", [], false) : v,
    );
    expect(defaultAutopilot(down)).toEqual({
      decider: "rule",
      model: "baseline",
    });
  });
});
