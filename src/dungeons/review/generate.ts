// Seeded generator of TypeScript code review cases: pull request diffs,
// failing test cases, CI logs, and multi-function files. Every buggy case
// is proven by running it in the interpreter on test inputs and edge cases;
// every safe refactor is verified to produce identical results.
// No hosted LLM touches the labels. Pure.

import { hash, pick, type Rng, seeded } from "../../lib/random.ts";
import { cloneModule, type Module } from "../code/ast.ts";
import { unifiedDiff } from "../code/diff.ts";
import {
  type Outcome,
  runCall,
  showOutcome,
  showValue,
  type Value,
} from "../code/interp.ts";
import {
  type BugClass,
  differs,
  mutant,
  mutationSites,
} from "../code/mutate.ts";
import { printModule } from "../code/print.ts";
import { refactored } from "../code/refactor.ts";
import {
  type Instance,
  instantiate,
  TEMPLATES,
  type Template,
} from "../code/templates.ts";
import type { TextCase } from "../text/cases.ts";
import { between } from "../text/vocab.ts";

export const REVIEW_GENERATOR = "review@1";

const AUTHORS = [
  "alex.chen@harborline.io",
  "sarah.connor@harborline.io",
  "liam.davies@harborline.io",
  "elena.rostova@harborline.io",
  "marcus.vance@harborline.io",
  "priya.sharma@harborline.io",
];

const BRANCHES = [
  "fix/boundary-check",
  "refactor/clean-loops",
  "perf/early-exit",
  "chore/modernize-syntax",
  "feat/edge-case-handling",
  "refactor/simplify-logic",
];

export interface FailingTest {
  call: string;
  expected: string;
  actual: string;
}

export interface ReviewGateInput {
  pr: number;
  title: string;
  author: string;
  branch: string;
  file: string;
  diff: string;
  description: string;
}

export interface LocateInput {
  file: string;
  code_with_line_numbers: string;
  failing_test: FailingTest;
}

export interface KindInput {
  file: string;
  code: string;
  failing_test: FailingTest;
}

export interface ReturnsInput {
  file: string;
  code: string;
  call: string;
  options: string[];
}

export type CiTriage = "regression" | "flaky" | "environment" | "test-bug";

export interface CiInput {
  pr: number;
  title: string;
  file: string;
  diff: string;
  ci_log: string[];
}

function fullInputs(tmpl: Template, rng: Rng): Value[][] {
  return [...tmpl.edges, ...Array.from({ length: 8 }, () => tmpl.input(rng))];
}

interface ProvenBug {
  original: Instance;
  mutated: Module;
  bugClass: BugClass;
  line: number;
  note: string;
  failingInput: Value[];
  expected: Outcome;
  actual: Outcome;
}

function findProvenBug(tmpl: Template, rng: Rng): ProvenBug | null {
  const inst = instantiate(tmpl, rng);
  const sites = mutationSites(inst.module);
  if (!sites.length) return null;

  const inputs = fullInputs(tmpl, rng);
  const perm = Array.from({ length: sites.length }, (_, i) => i);
  for (let i = perm.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const itemI = perm[i];
    const itemJ = perm[j];
    if (itemI !== undefined && itemJ !== undefined) {
      perm[i] = itemJ;
      perm[j] = itemI;
    }
  }

  for (const idx of perm) {
    const m = mutant(inst.module, idx);
    const failIdx = differs(inst.module, m.module, inst.fn, inputs);
    if (failIdx !== -1) {
      const failingInput = inputs[failIdx];
      if (!failingInput) continue;
      const expected = runCall(inst.module, inst.fn, failingInput);
      const actual = runCall(m.module, inst.fn, failingInput);
      const printedMutant = printModule(m.module);
      const line = printedMutant.lineOf.get(m.site.stmt) ?? 1;

      return {
        original: inst,
        mutated: m.module,
        bugClass: m.site.cls,
        line,
        note: m.site.note,
        failingInput,
        expected,
        actual,
      };
    }
  }
  return null;
}

function getProvenBug(tmpl: Template, rng: Rng): ProvenBug {
  const b = findProvenBug(tmpl, rng);
  if (b) return b;
  for (const alt of TEMPLATES) {
    const candidate = findProvenBug(alt, rng);
    if (candidate) return candidate;
  }
  throw new Error("failed to generate proven bug");
}

interface VerifiedRefactor {
  original: Instance;
  refactored: Module;
  notes: string[];
}

function findVerifiedRefactor(tmpl: Template, rng: Rng): VerifiedRefactor {
  const inst = instantiate(tmpl, rng);
  const inputs = fullInputs(tmpl, rng);

  const ref = refactored(
    inst.module,
    (sites) =>
      sites.length > 0 ? Math.floor(rng() * sites.length) : undefined,
    between(rng, 1, 3),
  );

  const diffIdx = differs(inst.module, ref.module, inst.fn, inputs);
  if (diffIdx === -1) {
    return {
      original: inst,
      refactored: ref.module,
      notes: ref.notes.length ? ref.notes : ["formatting cleanup"],
    };
  }
  // Fallback to unchanged copy if refactor failed equivalence
  return {
    original: inst,
    refactored: cloneModule(inst.module),
    notes: ["cosmetic cleanup"],
  };
}

function formatCall(fn: string, args: Value[]): string {
  return `${fn}(${args.map(showValue).join(", ")})`;
}

export function reviewCases(
  level: string,
  count: number,
  seed: number,
): TextCase[] {
  const rng = seeded(hash(`review:${level}`, seed));

  return Array.from({ length: count }, (_, index) => {
    const tmpl = pick(rng, TEMPLATES);
    const prNum = 1400 + index * 3 + Math.floor(rng() * 3);
    const author = pick(rng, AUTHORS);
    const branch = pick(rng, BRANCHES);
    const filename = `src/utils/${tmpl.id}.ts`;

    let input: Record<string, unknown>;
    let truth: Record<string, boolean | string | number>;
    let why: string;

    if (level === "gate") {
      const isBug = index % 2 === 0;
      if (isBug) {
        const bug = getProvenBug(tmpl, rng);
        const oldCode = printModule(bug.original.module).text;
        const newCode = printModule(bug.mutated).text;
        const diff = unifiedDiff(oldCode, newCode, filename);
        const call = formatCall(bug.original.fn, bug.failingInput);
        input = {
          pr: prNum,
          title: `Update ${bug.original.fn} implementation`,
          author,
          branch,
          file: filename,
          diff,
          description: `Modifies ${bug.original.fn} for clarity.`,
        };
        truth = { bug: true };
        why = `The change introduces a ${bug.bugClass} bug (${bug.note}): ${call} produces ${showOutcome(bug.actual)}, expected ${showOutcome(bug.expected)}.`;
      } else {
        const ref = findVerifiedRefactor(tmpl, rng);
        const oldCode = printModule(ref.original.module).text;
        const newCode = printModule(ref.refactored).text;
        const diff = unifiedDiff(oldCode, newCode, filename);
        input = {
          pr: prNum,
          title: `Refactor ${ref.original.fn} for readability`,
          author,
          branch,
          file: filename,
          diff:
            diff ||
            `--- a/${filename}\n+++ b/${filename}\n@@ -1,1 +1,1 @@\n// no-op refactor\n`,
          description: `Refactoring ${ref.original.fn}: ${ref.notes.join("; ")}.`,
        };
        truth = { bug: false };
        why = `Safe refactor: all tests pass identically with ${ref.notes.join("; ")}.`;
      }
    } else if (level === "locate") {
      const bug = getProvenBug(tmpl, rng);
      const printed = printModule(bug.mutated);
      const codeWithLineNumbers = printed.lines
        .map((l, i) => `${String(i + 1).padStart(3, " ")} | ${l}`)
        .join("\n");
      const call = formatCall(bug.original.fn, bug.failingInput);

      input = {
        file: filename,
        code_with_line_numbers: codeWithLineNumbers,
        failing_test: {
          call,
          expected: showOutcome(bug.expected),
          actual: showOutcome(bug.actual),
        },
        options: printed.lines.map((_, i) => String(i + 1)),
      };
      truth = { line: String(bug.line) };
      why = `Line ${bug.line} has the mutation (${bug.note}): ${call} fails with ${showOutcome(bug.actual)}.`;
    } else if (level === "kind") {
      const bug = getProvenBug(tmpl, rng);
      const printed = printModule(bug.mutated);
      const call = formatCall(bug.original.fn, bug.failingInput);

      input = {
        file: filename,
        code: printed.text,
        failing_test: {
          call,
          expected: showOutcome(bug.expected),
          actual: showOutcome(bug.actual),
        },
      };
      truth = { kind: bug.bugClass };
      why = `Bug class is ${bug.bugClass}: ${bug.note}.`;
    } else if (level === "returns") {
      const inst = instantiate(tmpl, rng);
      const args = tmpl.input(rng);
      const actualOutcome = runCall(inst.module, inst.fn, args);
      const correctStr = showOutcome(actualOutcome);

      // Collect 3 distractor outputs from mutants
      const distractors = new Set<string>();
      const sites = mutationSites(inst.module);
      for (let s = 0; s < sites.length && distractors.size < 3; s++) {
        const m = mutant(inst.module, s);
        const mOutcome = runCall(m.module, inst.fn, args);
        const mStr = showOutcome(mOutcome);
        if (mStr !== correctStr) {
          distractors.add(mStr);
        }
      }
      // If we don't have 3 distractors, add synthetic plausibles
      const val =
        actualOutcome.kind === "value" ? actualOutcome.value : undefined;
      if (typeof val === "number") {
        distractors.add(showValue(val + 1));
        distractors.add(showValue(val - 1));
        distractors.add(showValue(0));
      } else if (typeof val === "boolean") {
        distractors.add(showValue(!val));
      } else if (Array.isArray(val)) {
        distractors.add(showValue(val.slice(1)));
        distractors.add(showValue([...val, 0]));
        distractors.add("[]");
      } else if (typeof val === "string") {
        distractors.add(JSON.stringify(val.toUpperCase()));
        distractors.add(JSON.stringify(`${val}!`));
        distractors.add('""');
      } else {
        distractors.add("null");
        distractors.add("undefined");
      }
      distractors.delete(correctStr);

      const optionList = [correctStr, ...Array.from(distractors).slice(0, 3)];
      // Shuffle options deterministically
      for (let i = optionList.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const itemI = optionList[i];
        const itemJ = optionList[j];
        if (itemI !== undefined && itemJ !== undefined) {
          optionList[i] = itemJ;
          optionList[j] = itemI;
        }
      }

      const printed = printModule(inst.module);
      const call = formatCall(inst.fn, args);
      input = {
        file: filename,
        code: printed.text,
        call,
        options: optionList,
      };
      truth = { returns: correctStr };
      why = `${call} returns ${correctStr}.`;
    } else if (level === "ci") {
      const triageType: CiTriage = pick(rng, [
        "regression",
        "flaky",
        "environment",
        "test-bug",
      ]);
      const bug = getProvenBug(tmpl, rng);
      const ref = findVerifiedRefactor(tmpl, rng);

      let diff = "";
      let ciLog: string[] = [];

      if (triageType === "regression") {
        const oldCode = printModule(bug.original.module).text;
        const newCode = printModule(bug.mutated).text;
        diff = unifiedDiff(oldCode, newCode, filename);
        const call = formatCall(bug.original.fn, bug.failingInput);
        ciLog = [
          `Running test suite on branch ${branch}...`,
          `PASS tests/utils/base.test.ts (24ms)`,
          `FAIL tests/utils/${tmpl.id}.test.ts`,
          `  ✕ ${bug.original.fn} > handles ${call}`,
          `    Expected: ${showOutcome(bug.expected)}`,
          `    Received: ${showOutcome(bug.actual)}`,
          `    at ${filename}:${bug.line}:7`,
          `Tests: 1 failed, 14 passed, 15 total`,
        ];
        why = `Regression: recent code change at line ${bug.line} causes ${formatCall(bug.original.fn, bug.failingInput)} to fail.`;
      } else if (triageType === "flaky") {
        const oldCode = printModule(ref.original.module).text;
        const newCode = printModule(ref.refactored).text;
        diff = unifiedDiff(oldCode, newCode, filename);
        ciLog = [
          `Running test suite on branch ${branch}...`,
          `FAIL tests/integration/async-queue.test.ts`,
          `  ✕ queue > should process items within 50ms window`,
          `    TimeoutError: Timeout of 50ms exceeded in hook.`,
          `Retrying failed test (attempt 2 of 3)...`,
          `PASS tests/integration/async-queue.test.ts (retry passed in 12ms)`,
          `Warning: Test passed on retry, marking run unstable.`,
          `Tests: 1 flaky, 18 passed, 19 total`,
        ];
        why = `Flaky test: unrelated async timing test failed on first run and passed on retry. Code changes are clean.`;
      } else if (triageType === "environment") {
        const oldCode = printModule(ref.original.module).text;
        const newCode = printModule(ref.refactored).text;
        diff = unifiedDiff(oldCode, newCode, filename);
        ciLog = [
          `Setting up runner container environment...`,
          `Error: ENOSPC: no space left on device, write '/tmp/build-cache.tar'`,
          `Worker process terminated with exit code 128`,
          `Error: Runner failed to initialize sandbox environment before tests started.`,
        ];
        why = `Environment failure: ENOSPC on container runner, no tests were executed.`;
      } else {
        // test-bug
        const oldCode = printModule(ref.original.module).text;
        const newCode = printModule(ref.refactored).text;
        const codeDiff = unifiedDiff(oldCode, newCode, filename);
        const testDiff = `--- a/tests/utils/${tmpl.id}.test.ts\n+++ b/tests/utils/${tmpl.id}.test.ts\n@@ -12,2 +12,2 @@\n-  expect(${ref.original.fn}([1, 2])).toBe(2);\n+  expect(${ref.original.fn}([1, 2])).toBe(999);\n`;
        diff = `${codeDiff}\n${testDiff}`;
        ciLog = [
          `Running test suite on branch ${branch}...`,
          `FAIL tests/utils/${tmpl.id}.test.ts`,
          `  ✕ ${ref.original.fn} > expected 999 but received 2`,
          `    at tests/utils/${tmpl.id}.test.ts:13:3`,
          `Tests: 1 failed, 12 passed, 13 total`,
        ];
        why = `Broken test: the PR modified the test expectation to an incorrect value (999) while implementation is correct.`;
      }

      input = {
        pr: prNum,
        title: `PR #${prNum}: CI check on ${branch}`,
        file: filename,
        diff,
        ci_log: ciLog,
      };
      truth = { triage: triageType };
    } else if (level === "long") {
      // Multiple functions concatenated into a single file
      const countFns = between(rng, 5, 7);
      const templates = Array.from({ length: countFns }, () =>
        pick(rng, TEMPLATES),
      );
      const instances = templates.map((t) => instantiate(t, rng));
      const combinedModule: Module = {
        fns: instances.flatMap((inst) => inst.module.fns),
      };

      const isBug = index % 2 === 0;
      const targetIdx = Math.floor(rng() * countFns);
      const targetInst = instances[targetIdx] ?? instances[0];
      if (!targetInst) throw new Error("no instance");

      if (isBug) {
        const bug = getProvenBug(targetInst.template, rng);
        // Replace target functions in combined
        const modifiedFns = instances.flatMap((inst, idx) =>
          idx === targetIdx ? bug.mutated.fns : inst.module.fns,
        );
        const modifiedModule: Module = { fns: modifiedFns };
        const oldCode = printModule(combinedModule).text;
        const newCode = printModule(modifiedModule).text;
        const diff = unifiedDiff(oldCode, newCode, "src/utils/bundle.ts");

        input = {
          pr: prNum,
          title: `Update utility functions in bundle.ts`,
          author,
          branch,
          file: "src/utils/bundle.ts",
          diff,
          description: `Updated ${bug.original.fn} in the utility bundle.`,
        };
        truth = { bug: true };
        why = `Buggy: mutation in ${bug.original.fn} introduces ${bug.bugClass} bug (${bug.note}).`;
      } else {
        const ref = findVerifiedRefactor(targetInst.template, rng);
        const modifiedFns = instances.flatMap((inst, idx) =>
          idx === targetIdx ? ref.refactored.fns : inst.module.fns,
        );
        const modifiedModule: Module = { fns: modifiedFns };
        const oldCode = printModule(combinedModule).text;
        const newCode = printModule(modifiedModule).text;
        const diff = unifiedDiff(oldCode, newCode, "src/utils/bundle.ts");

        input = {
          pr: prNum,
          title: `Clean up utility bundle`,
          author,
          branch,
          file: "src/utils/bundle.ts",
          diff:
            diff ||
            `--- a/src/utils/bundle.ts\n+++ b/src/utils/bundle.ts\n@@ -1,1 +1,1 @@\n// bundle refactor\n`,
          description: `Cleaned up ${ref.original.fn}: ${ref.notes.join("; ")}.`,
        };
        truth = { bug: false };
        why = `Safe refactor in ${ref.original.fn} (${ref.notes.join("; ")}).`;
      }
    } else {
      // all-questions
      const isBug = index % 2 === 0;
      if (isBug) {
        const bug = getProvenBug(tmpl, rng);
        const oldCode = printModule(bug.original.module).text;
        const newCode = printModule(bug.mutated).text;
        const diff = unifiedDiff(oldCode, newCode, filename);
        const call = formatCall(bug.original.fn, bug.failingInput);

        input = {
          pr: prNum,
          title: `Update ${bug.original.fn}`,
          author,
          branch,
          file: filename,
          diff,
          failing_test: {
            call,
            expected: showOutcome(bug.expected),
            actual: showOutcome(bug.actual),
          },
          description: `Changes to ${bug.original.fn}.`,
        };
        truth = { bug: true, kind: bug.bugClass };
        why = `Introduces ${bug.bugClass} bug (${bug.note}): ${call} fails with ${showOutcome(bug.actual)}.`;
      } else {
        const ref = findVerifiedRefactor(tmpl, rng);
        const oldCode = printModule(ref.original.module).text;
        const newCode = printModule(ref.refactored).text;
        const diff = unifiedDiff(oldCode, newCode, filename);

        input = {
          pr: prNum,
          title: `Refactor ${ref.original.fn}`,
          author,
          branch,
          file: filename,
          diff:
            diff ||
            `--- a/${filename}\n+++ b/${filename}\n@@ -1,1 +1,1 @@\n// refactor\n`,
          description: `Refactored ${ref.original.fn}: ${ref.notes.join("; ")}.`,
        };
        truth = { bug: false, kind: "none" };
        why = `Safe refactor: ${ref.notes.join("; ")}.`;
      }
    }

    return {
      id: `${level}-${String(index + 1).padStart(4, "0")}`,
      level,
      lang: "en",
      input: input as unknown as TextCase["input"],
      truth,
      why,
    };
  });
}
