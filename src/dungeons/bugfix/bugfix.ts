// Bugfix Workbench: the autopilot acts as a debugging agent. Given a TypeScript
// module with failing tests, it explores the workspace in turns: running the
// test suite, inspecting functions, evaluating candidate patches, reverting
// regressions, and submitting when ready. Final score checks both public tests
// and hidden evaluation suites. Headless, turn-based, and deterministic.

import type { Answers } from "../../contract/answer.ts";
import type { Decider } from "../../contract/decider.ts";
import { DecideError } from "../../contract/errors.ts";
import type {
  ChoiceQuestion,
  JsonValue,
  Request,
} from "../../contract/request.ts";
import { type Rng, seeded } from "../../lib/random.ts";
import { cloneModule, type Expr, type Module, type Stmt } from "../code/ast.ts";
import { unifiedDiff } from "../code/diff.ts";
import {
  type Outcome as InterpOutcome,
  runCall,
  sameOutcome,
  type Value,
} from "../code/interp.ts";
import { differs, mutant, mutationSites } from "../code/mutate.ts";
import { printModule } from "../code/print.ts";
import { refactorSites } from "../code/refactor.ts";
import { instantiate, TEMPLATES, withHelpers } from "../code/templates.ts";
import type { DecisionRecord, Dungeon, Level, Outcome } from "../dungeon.ts";

export interface BugfixLevel extends Level {
  mode: "single" | "multi" | "overfit" | "noisy";
  maxTurns: number;
}

export const BUGFIX_LEVELS: BugfixLevel[] = [
  {
    id: "single",
    title: "Single defect",
    description:
      "A standalone function with a single seeded defect. Run tests, inspect the implementation, select the correct patch, and submit.",
    mode: "single",
    maxTurns: 8,
  },
  {
    id: "multi",
    title: "Multi-function module",
    description:
      "A module with helper functions. Only one function has the defect. Locate the culprit among the functions, repair it, and verify.",
    mode: "multi",
    maxTurns: 12,
  },
  {
    id: "overfit",
    title: "Beware overfitting",
    description:
      "A tricky boundary defect where a quick-hack patch passes all public tests, but only the genuine fix generalizes to the hidden evaluation suite.",
    mode: "overfit",
    maxTurns: 10,
  },
  {
    id: "noisy",
    title: "Multiple defects",
    description:
      "Two distinct defects in the module. Triage test failures, apply sequential patches, and ensure all defects are resolved before submission.",
    mode: "noisy",
    maxTurns: 16,
  },
];

const levelOf = (id: string): BugfixLevel | undefined =>
  BUGFIX_LEVELS.find((l) => l.id === id);

export interface TestCase {
  args: Value[];
  expected: InterpOutcome;
}

export interface FailingCall {
  call: string;
  expected: string;
  actual: string;
}

export interface TestRunSummary {
  total: number;
  passed: number;
  failed: number;
  failures: FailingCall[];
}

export interface CandidatePatch {
  id: string;
  fn: string;
  summary: string;
  diff: string;
  patchedModule: Module;
  isCorrectFix: boolean;
  isOverfit?: boolean;
}

export interface BugfixRun {
  seed: number;
  level: BugfixLevel;
  workspace: Module;
  originalModule: Module;
  targetFn: string;
  faultyFns: string[];
  functions: string[];
  inspectedFn: string | null;
  undoStack: Module[];
  turn: number;
  maxTurns: number;
  patchesApplied: number;
  revertsCount: number;
  lastActionSummary: string;
  lastTestResults: TestRunSummary | null;
  availablePatches: CandidatePatch[];
  publicTests: TestCase[];
  hiddenTests: TestCase[];
  submitted: boolean;
  finished: boolean;
  passed?: boolean;
  records: DecisionRecord[];
}

function formatValue(v: unknown): string {
  if (v === undefined) return "undefined";
  if (typeof v === "number" && Object.is(v, -0)) return "-0";
  return JSON.stringify(v);
}

function formatOutcome(outcome: InterpOutcome): string {
  if (outcome.kind === "throw") return `Error: ${outcome.error}`;
  if (outcome.kind === "timeout") return "Timeout";
  return formatValue(outcome.value);
}

function formatCall(fnName: string, args: Value[]): string {
  return `${fnName}(${args.map(formatValue).join(", ")})`;
}

function runSuite(
  m: Module,
  fnName: string,
  tests: TestCase[],
): TestRunSummary {
  let passed = 0;
  const failures: FailingCall[] = [];

  for (const t of tests) {
    const actual = runCall(m, fnName, t.args);
    if (sameOutcome(actual, t.expected)) {
      passed++;
    } else {
      failures.push({
        call: formatCall(fnName, t.args),
        expected: formatOutcome(t.expected),
        actual: formatOutcome(actual),
      });
    }
  }

  return {
    total: tests.length,
    passed,
    failed: tests.length - passed,
    failures,
  };
}

function printFunction(m: Module, fnName: string): string {
  const f = m.fns.find((fn) => fn.name === fnName);
  if (!f) return `// Function ${fnName} not found`;
  const single = { fns: [f] };
  return printModule(single).text;
}

/** Generates candidate patches for the currently inspected function */
function generateCandidatePatches(run: BugfixRun, rng: Rng): CandidatePatch[] {
  if (!run.inspectedFn) return [];
  const fnName = run.inspectedFn;
  const currentFnCode = printFunction(run.workspace, fnName);
  const patches: CandidatePatch[] = [];

  const originalFn = run.originalModule.fns.find((f) => f.name === fnName);
  const currentFn = run.workspace.fns.find((f) => f.name === fnName);
  if (!originalFn || !currentFn) return [];

  const originalFnCode = printFunction(run.originalModule, fnName);
  const isBuggy = currentFnCode !== originalFnCode;

  if (isBuggy) {
    // 1. The genuine clean fix
    const fixedModule = cloneModule(run.workspace);
    const targetIdx = fixedModule.fns.findIndex((f) => f.name === fnName);
    if (targetIdx !== -1) {
      const cloned = cloneModule({ fns: [originalFn] }).fns[0];
      if (cloned) {
        fixedModule.fns[targetIdx] = cloned;
        const diff = unifiedDiff(currentFnCode, originalFnCode, `${fnName}.ts`);
        patches.push({
          id: "fix",
          fn: fnName,
          summary: `Restore verified logic in ${fnName}`,
          diff,
          patchedModule: fixedModule,
          isCorrectFix: true,
        });
      }
    }

    // 2. An overfitting patch for the "overfit" level mode
    if (run.level.mode === "overfit") {
      const failingTest = run.publicTests.find(
        (t) =>
          !sameOutcome(
            runCall(run.workspace, run.targetFn, t.args),
            t.expected,
          ),
      );
      if (
        failingTest &&
        failingTest.expected.kind === "value" &&
        originalFn.body.length > 0
      ) {
        const overfitModule = cloneModule(run.workspace);
        const idx = overfitModule.fns.findIndex((f) => f.name === fnName);
        const fnCopy = idx !== -1 ? overfitModule.fns[idx] : undefined;
        if (fnCopy) {
          const firstArg = failingTest.args[0];
          let guardStmt: Stmt | null = null;
          const retExpr: Expr =
            typeof failingTest.expected.value === "number"
              ? { k: "num", v: failingTest.expected.value }
              : typeof failingTest.expected.value === "boolean"
                ? { k: "bool", v: failingTest.expected.value }
                : { k: "str", v: String(failingTest.expected.value) };

          if (Array.isArray(firstArg) && firstArg.length === 0) {
            guardStmt = {
              k: "if",
              c: {
                k: "bin",
                op: "===",
                l: {
                  k: "mem",
                  obj: { k: "id", name: fnCopy.params[0]?.name ?? "xs" },
                  prop: "length",
                },
                r: { k: "num", v: 0 },
              },
              consequent: [{ k: "return", e: retExpr }],
            };
          } else if (typeof firstArg === "number") {
            guardStmt = {
              k: "if",
              c: {
                k: "bin",
                op: "===",
                l: { k: "id", name: fnCopy.params[0]?.name ?? "x" },
                r: { k: "num", v: firstArg },
              },
              consequent: [{ k: "return", e: retExpr }],
            };
          }

          if (guardStmt) {
            fnCopy.body.unshift(guardStmt);
            const overfitCode = printFunction(overfitModule, fnName);
            const diff = unifiedDiff(
              currentFnCode,
              overfitCode,
              `${fnName}.ts`,
            );
            patches.push({
              id: "overfit_guard",
              fn: fnName,
              summary: `Add early guard for special-case input in ${fnName}`,
              diff,
              patchedModule: overfitModule,
              isCorrectFix: false,
              isOverfit: true,
            });
          }
        }
      }
    }

    // 3. Distractor patch: alternate mutation
    const sites = mutationSites(run.workspace);
    const fnSites = sites.filter((s) => s.fn === fnName);
    if (fnSites.length > 0) {
      const siteIdx = Math.floor(rng() * fnSites.length);
      const chosenSite = fnSites[siteIdx];
      if (chosenSite) {
        const distractorModule = cloneModule(run.workspace);
        const distractorSites = mutationSites(distractorModule);
        const match = distractorSites.find(
          (s) => s.fn === fnName && s.note === chosenSite.note,
        );
        if (match) {
          match.apply();
          const distractorCode = printFunction(distractorModule, fnName);
          const diff = unifiedDiff(
            currentFnCode,
            distractorCode,
            `${fnName}.ts`,
          );
          patches.push({
            id: "distractor_mut",
            fn: fnName,
            summary: `Alternative modification: ${match.note}`,
            diff,
            patchedModule: distractorModule,
            isCorrectFix: false,
          });
        }
      }
    }
  }

  // 4. Safe refactor patch
  const sites = refactorSites(run.workspace);
  const fnSite = sites.find((s) => s.fn === fnName);
  if (fnSite) {
    const refactoredModule = cloneModule(run.workspace);
    const refMatch = refactorSites(refactoredModule).find(
      (s) => s.fn === fnName && s.note === fnSite.note,
    );
    if (refMatch) {
      refMatch.apply();
      const refCode = printFunction(refactoredModule, fnName);
      const diff = unifiedDiff(currentFnCode, refCode, `${fnName}.ts`);
      patches.push({
        id: "refactor_syntax",
        fn: fnName,
        summary: `Refactor syntax structure (${fnSite.kind})`,
        diff,
        patchedModule: refactoredModule,
        isCorrectFix: false,
      });
    }
  }

  return patches;
}

export function bugfixRequest(run: BugfixRun): Request {
  const inspectedSource = run.inspectedFn
    ? printFunction(run.workspace, run.inspectedFn)
    : null;

  const state: Record<string, JsonValue> = {
    turn: run.turn,
    max_turns: run.maxTurns,
    functions: run.functions,
    inspected_function: run.inspectedFn,
    inspected_source: inspectedSource,
    last_action: run.lastActionSummary,
    modified: run.undoStack.length > 0,
    candidate_patches: run.availablePatches.map((p) => ({
      id: p.id,
      function: p.fn,
      summary: p.summary,
      diff: p.diff,
    })),
  };

  if (run.lastTestResults) {
    state.test_results = {
      total: run.lastTestResults.total,
      passed: run.lastTestResults.passed,
      failed: run.lastTestResults.failed,
      failures: run.lastTestResults.failures.map((f) => ({
        call: f.call,
        expected: f.expected,
        actual: f.actual,
      })),
    };
  }

  const options: { id: string; description: string }[] = [];
  options.push({
    id: "run_tests",
    description: "Run the public test suite against current workspace code",
  });

  for (const fn of run.functions) {
    if (fn !== run.inspectedFn) {
      options.push({
        id: `inspect:${fn}`,
        description: `Inspect source code of function '${fn}'`,
      });
    }
  }

  for (const p of run.availablePatches) {
    options.push({
      id: `apply:${p.id}`,
      description: `Apply patch '${p.id}' to '${p.fn}': ${p.summary}`,
    });
  }

  if (run.undoStack.length > 0) {
    options.push({
      id: "revert",
      description: "Revert the most recently applied patch",
    });
  }

  options.push({
    id: "submit",
    description: "Submit current workspace code for final evaluation",
  });

  return {
    state,
    questions: {
      action: {
        type: "choice",
        instructions:
          "Choose the next action in the debugging session: run tests, inspect a function, apply a candidate patch, revert, or submit.",
        criteria: Object.fromEntries(options.map((o) => [o.id, o.description])),
      },
    },
  };
}

export const bugfixRule: Decider = {
  id: "rule",
  label: "Deterministic Debugger",
  models: async () => [{ id: "baseline", label: "Baseline", available: true }],
  status: async () => ({ configured: true, reachable: true }),
  async decide(request) {
    const q = request.questions.action as ChoiceQuestion | undefined;
    if (!q)
      throw new DecideError("rejected", "no action question in bugfix request");
    const state = request.state as {
      turn: number;
      test_results?: { passed: number; failed: number };
      inspected_function?: string | null;
      candidate_patches?: { id: string; summary: string }[];
    };
    const optionIds = Object.keys(q.criteria);

    // 1. If tests have not been run or patch applied without re-running tests:
    if (!state.test_results) {
      if (optionIds.includes("run_tests")) {
        return {
          decider: "rule",
          model: "baseline",
          answers: { action: { type: "choice", choice: "run_tests" } },
          timings: { total: 0 },
        };
      }
    }

    // 2. If tests ran and all passed:
    if (state.test_results && state.test_results.failed === 0) {
      if (optionIds.includes("submit")) {
        return {
          decider: "rule",
          model: "baseline",
          answers: { action: { type: "choice", choice: "submit" } },
          timings: { total: 0 },
        };
      }
    }

    // 3. If tests failed:
    if (state.test_results && state.test_results.failed > 0) {
      const patchFix = optionIds.find((id) => id === "apply:fix");
      if (patchFix) {
        return {
          decider: "rule",
          model: "baseline",
          answers: { action: { type: "choice", choice: patchFix } },
          timings: { total: 0 },
        };
      }

      const safePatch = optionIds.find(
        (id) =>
          id.startsWith("apply:") &&
          !id.includes("overfit") &&
          !id.includes("distractor") &&
          !id.includes("refactor"),
      );
      if (safePatch) {
        return {
          decider: "rule",
          model: "baseline",
          answers: { action: { type: "choice", choice: safePatch } },
          timings: { total: 0 },
        };
      }

      const inspectOption = optionIds.find((id) => id.startsWith("inspect:"));
      if (inspectOption) {
        return {
          decider: "rule",
          model: "baseline",
          answers: { action: { type: "choice", choice: inspectOption } },
          timings: { total: 0 },
        };
      }
    }

    const fallback = optionIds.includes("run_tests")
      ? "run_tests"
      : (optionIds[0] ?? "submit");
    return {
      decider: "rule",
      model: "baseline",
      answers: { action: { type: "choice", choice: fallback } },
      timings: { total: 0 },
    };
  },
};

export const bugfix: Dungeon<BugfixRun> = {
  id: "bugfix",
  title: "Bugfix Workbench",
  description:
    "The autopilot acts as a software engineering agent debugging code: run tests, inspect functions, apply candidate patches, revert, and submit for evaluation.",
  levels: BUGFIX_LEVELS.map(({ mode: _, maxTurns: __, ...level }) => level),
  create(seed, levelId) {
    const level = levelOf(levelId);
    if (!level) throw new Error(`bugfix has no level ${levelId}`);

    const rng = seeded(seed * 31 + levelId.charCodeAt(0));
    const tmpls = level.mode === "multi" ? withHelpers() : TEMPLATES;
    const tmpl =
      tmpls[Math.floor(rng() * tmpls.length)] ?? tmpls[0] ?? TEMPLATES[0];
    if (!tmpl) throw new Error("no templates available");
    const inst = instantiate(tmpl, rng);

    const originalModule = cloneModule(inst.module);
    const targetFn = inst.fn;
    const allFns = inst.module.fns.map((f) => f.name);

    // Inputs: public tests + hidden evaluation tests
    const edgeInputs = tmpl.edges;
    const randomInputs = Array.from({ length: 12 }, () => tmpl.input(rng));
    const allInputs = [...edgeInputs, ...randomInputs];

    // Seed mutation(s)
    let workspace = cloneModule(inst.module);
    const sites = mutationSites(workspace);
    const faultyFns: string[] = [];

    if (level.mode === "noisy") {
      const failingSites: number[] = [];
      for (let i = 0; i < sites.length; i++) {
        const m = mutant(originalModule, i);
        if (differs(originalModule, m.module, targetFn, allInputs) !== -1) {
          failingSites.push(i);
          if (failingSites.length >= 2) break;
        }
      }
      const site1 = failingSites[0];
      if (site1 !== undefined) {
        const m1 = mutant(workspace, site1);
        workspace = m1.module;
        faultyFns.push(m1.site.fn);
        const site2 = failingSites[1];
        if (site2 !== undefined) {
          const m2 = mutant(workspace, site2);
          workspace = m2.module;
          if (!faultyFns.includes(m2.site.fn)) faultyFns.push(m2.site.fn);
        }
      }
    } else {
      let chosenMutant = mutant(workspace, 0);
      for (let i = 0; i < sites.length; i++) {
        const m = mutant(workspace, i);
        if (differs(originalModule, m.module, targetFn, allInputs) !== -1) {
          chosenMutant = m;
          break;
        }
      }
      workspace = chosenMutant.module;
      faultyFns.push(chosenMutant.site.fn);
    }

    // Partition inputs into public and hidden
    const failIdx = differs(originalModule, workspace, targetFn, allInputs);
    const publicInputs: Value[][] = [];
    const hiddenInputs: Value[][] = [];

    if (failIdx !== -1) {
      const inp = allInputs[failIdx];
      if (inp) publicInputs.push(inp);
    }
    for (let i = 0; i < allInputs.length; i++) {
      const inp = allInputs[i];
      if (!inp) continue;
      if (i !== failIdx && publicInputs.length < 4) {
        publicInputs.push(inp);
      } else if (i !== failIdx) {
        hiddenInputs.push(inp);
      }
    }

    const publicTests: TestCase[] = publicInputs.map((args) => ({
      args,
      expected: runCall(originalModule, targetFn, args),
    }));

    const hiddenTests: TestCase[] = hiddenInputs.map((args) => ({
      args,
      expected: runCall(originalModule, targetFn, args),
    }));

    const initialInspected = faultyFns[0] ?? allFns[0] ?? null;

    const initialRun: BugfixRun = {
      seed,
      level,
      workspace,
      originalModule,
      targetFn,
      faultyFns,
      functions: allFns,
      inspectedFn: initialInspected,
      undoStack: [],
      turn: 0,
      maxTurns: level.maxTurns,
      patchesApplied: 0,
      revertsCount: 0,
      lastActionSummary:
        "Workspace loaded with initial source code and test suite.",
      lastTestResults: null,
      availablePatches: [],
      publicTests,
      hiddenTests,
      submitted: false,
      finished: false,
      records: [],
    };

    initialRun.availablePatches = generateCandidatePatches(initialRun, rng);
    return initialRun;
  },
  observe(run) {
    return { request: bugfixRequest(run) };
  },
  apply(run, answers: Answers) {
    if (run.finished) return;

    const answer = answers.action;
    const choice = answer?.type === "choice" ? answer.choice : undefined;
    if (!choice) return;

    const turnIndex = run.turn;
    const rng = seeded(run.seed * 31 + run.turn * 17);

    if (choice === "run_tests") {
      const summary = runSuite(run.workspace, run.targetFn, run.publicTests);
      run.lastTestResults = summary;
      run.lastActionSummary = `Executed public test suite: ${summary.passed}/${summary.total} passed.`;
      run.records.push({
        index: turnIndex,
        summary: `run_tests: ${summary.passed}/${summary.total} passed (${summary.failed} failed)`,
        correct: summary.failed === 0,
      });
      run.turn++;
    } else if (choice.startsWith("inspect:")) {
      const fnName = choice.slice("inspect:".length);
      if (run.functions.includes(fnName)) {
        run.inspectedFn = fnName;
        run.availablePatches = generateCandidatePatches(run, rng);
        run.lastActionSummary = `Inspected function '${fnName}'. ${run.availablePatches.length} candidate patches available.`;
        run.records.push({
          index: turnIndex,
          summary: `inspect: ${fnName} (${run.availablePatches.length} patches available)`,
          correct: true,
        });
        run.turn++;
      }
    } else if (choice.startsWith("apply:")) {
      const patchId = choice.slice("apply:".length);
      const patch = run.availablePatches.find((p) => p.id === patchId);
      if (patch) {
        run.undoStack.push(cloneModule(run.workspace));
        run.workspace = cloneModule(patch.patchedModule);
        run.patchesApplied++;
        run.availablePatches = generateCandidatePatches(run, rng);
        run.lastTestResults = null;
        run.lastActionSummary = `Applied patch '${patchId}' to '${patch.fn}': ${patch.summary}.`;
        run.records.push({
          index: turnIndex,
          summary: `apply: ${patchId} on ${patch.fn} (${patch.summary})`,
          correct: patch.isCorrectFix,
        });
        run.turn++;
      }
    } else if (choice === "revert") {
      if (run.undoStack.length > 0) {
        const prev = run.undoStack.pop();
        if (prev) {
          run.workspace = prev;
          run.revertsCount++;
          run.availablePatches = generateCandidatePatches(run, rng);
          run.lastTestResults = null;
          run.lastActionSummary = "Reverted workspace to previous patch state.";
          run.records.push({
            index: turnIndex,
            summary: "revert: restored previous workspace state",
            correct: true,
          });
          run.turn++;
        }
      }
    } else if (choice === "submit") {
      run.submitted = true;
      const publicRes = runSuite(run.workspace, run.targetFn, run.publicTests);
      const hiddenRes = runSuite(run.workspace, run.targetFn, run.hiddenTests);
      run.passed = publicRes.failed === 0 && hiddenRes.failed === 0;
      run.finished = true;
      run.lastActionSummary = run.passed
        ? "Submitted workspace code: PASSED all public and hidden evaluation tests!"
        : `Submitted workspace code: FAILED evaluation tests (public: ${publicRes.passed}/${publicRes.total}, hidden: ${hiddenRes.passed}/${hiddenRes.total}).`;
      run.records.push({
        index: turnIndex,
        summary: `submit: ${run.passed ? "PASSED" : "FAILED"} (public: ${publicRes.passed}/${publicRes.total}, hidden: ${hiddenRes.passed}/${hiddenRes.total})`,
        correct: run.passed,
        ...(run.passed
          ? {}
          : { violation: "Failed hidden or public evaluation test cases" }),
      });
      run.turn++;
    }

    if (run.turn >= run.maxTurns && !run.finished) {
      run.submitted = true;
      const publicRes = runSuite(run.workspace, run.targetFn, run.publicTests);
      const hiddenRes = runSuite(run.workspace, run.targetFn, run.hiddenTests);
      run.passed = publicRes.failed === 0 && hiddenRes.failed === 0;
      run.finished = true;
      run.records.push({
        index: run.turn,
        summary: `turn budget exceeded: auto-submitted (${run.passed ? "PASSED" : "FAILED"})`,
        correct: run.passed,
        ...(run.passed
          ? {}
          : { violation: "Turn budget exceeded before passing all tests" }),
      });
    }
  },
  step() {},
  outcome(run): Outcome {
    const publicRes = runSuite(run.workspace, run.targetFn, run.publicTests);
    const hiddenRes = runSuite(run.workspace, run.targetFn, run.hiddenTests);
    const violations = run.finished && !run.passed ? 1 : 0;

    return {
      finished: run.finished,
      ...(run.finished ? { passed: run.passed ?? false } : {}),
      violations,
      metrics: {
        turns: run.turn,
        patches_applied: run.patchesApplied,
        reverts: run.revertsCount,
        public_passed: publicRes.passed,
        public_total: publicRes.total,
        hidden_passed: hiddenRes.passed,
        hidden_total: hiddenRes.total,
        solved: run.passed ? 1 : 0,
      },
      records: run.records,
    };
  },
  rule: bugfixRule,
};
