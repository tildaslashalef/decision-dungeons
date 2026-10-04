// Tests for the Bugfix Workbench dungeon: case generation, determinism,
// candidate patch application, undo/revert, and baseline rule execution.

import { describe, expect, it } from "bun:test";
import { parseRequest } from "../src/contract/validate.ts";
import { BUGFIX_LEVELS, bugfix } from "../src/dungeons/bugfix/bugfix.ts";
import { runEpisode } from "../src/dungeons/run.ts";

describe("bugfix workbench dungeon", () => {
  it("creates valid runs for all levels with initial defects and tests", () => {
    for (const level of BUGFIX_LEVELS) {
      const run = bugfix.create(42, level.id);
      expect(run.level.id).toBe(level.id);
      expect(run.functions.length).toBeGreaterThan(0);
      expect(run.publicTests.length).toBeGreaterThanOrEqual(2);
      expect(run.hiddenTests.length).toBeGreaterThanOrEqual(4);
      expect(run.undoStack.length).toBe(0);
      expect(run.turn).toBe(0);
      expect(run.finished).toBe(false);

      const obs = bugfix.observe(run);
      // Valid contract request
      const req = parseRequest(obs.request);
      expect(req.questions.action).toBeDefined();
      expect(req.questions.action?.type).toBe("choice");
    }
  });

  it("produces deterministic runs for identical seed and decisions", async () => {
    const run1 = await runEpisode(
      bugfix,
      "single",
      7,
      { id: "rule", model: "baseline" },
      async (req) =>
        bugfix.rule.decide(req, {
          model: "baseline",
          signal: new AbortController().signal,
        }),
    );

    const run2 = await runEpisode(
      bugfix,
      "single",
      7,
      { id: "rule", model: "baseline" },
      async (req) =>
        bugfix.rule.decide(req, {
          model: "baseline",
          signal: new AbortController().signal,
        }),
    );

    expect(run1.outcome.finished).toBe(true);
    expect(run1.outcome.passed).toBe(true);
    expect(run1.outcome.metrics).toEqual(run2.outcome.metrics);
    expect(run1.outcome.records.map((r) => r.summary)).toEqual(
      run2.outcome.records.map((r) => r.summary),
    );
  });

  it("baseline rule successfully solves all levels including noisy", async () => {
    for (const levelId of ["single", "multi", "overfit", "noisy"]) {
      const res = await runEpisode(
        bugfix,
        levelId,
        101,
        { id: "rule", model: "baseline" },
        async (req) =>
          bugfix.rule.decide(req, {
            model: "baseline",
            signal: new AbortController().signal,
          }),
      );

      expect(res.outcome.finished).toBe(true);
      expect(res.outcome.passed).toBe(true);
      expect(res.outcome.violations).toBe(0);
      expect(res.outcome.metrics.solved).toBe(1);
    }
  });

  it("supports patch application and revert", () => {
    const run = bugfix.create(123, "single");
    const initialCode = JSON.stringify(run.workspace);

    // Apply run_tests first
    bugfix.apply(run, { action: { type: "choice", choice: "run_tests" } });
    expect(run.lastTestResults).toBeDefined();

    // Inspect function
    const fn = run.functions[0] ?? "clamp";
    bugfix.apply(run, { action: { type: "choice", choice: `inspect:${fn}` } });
    expect(run.availablePatches.length).toBeGreaterThan(0);

    const patch = run.availablePatches[0];
    if (!patch) throw new Error("expected at least one candidate patch");
    bugfix.apply(run, {
      action: { type: "choice", choice: `apply:${patch.id}` },
    });
    expect(run.undoStack.length).toBe(1);
    expect(run.patchesApplied).toBe(1);

    // Revert
    bugfix.apply(run, { action: { type: "choice", choice: "revert" } });
    expect(run.undoStack.length).toBe(0);
    expect(run.revertsCount).toBe(1);
    expect(JSON.stringify(run.workspace)).toBe(initialCode);
  });
});
