// Code Review: a text dungeon for decision models evaluating code.
// Levels cover review gating (does this diff introduce a bug?), fault
// localization (which line is wrong?), bug classification (off-by-one,
// operator, etc.), evaluation (what does it return?), and CI triage.
// Scored against deterministically proven bugs and verified refactors. Pure.

import type { Answers } from "../../contract/answer.ts";
import type {
  ChoiceQuestion,
  NoulQuestion,
  Question,
  Request,
} from "../../contract/request.ts";
import { BUG_CLASSES } from "../code/mutate.ts";
import type { TextCase } from "../text/cases.ts";
import { type TextLevel, textDungeon } from "../text/text-dungeon.ts";

export const BUG_QUESTION: NoulQuestion = {
  type: "noul",
  instructions:
    "Does this change introduce a bug? Answer true (high probability) if the diff or change causes a bug, incorrect calculation, crash, or regression; answer false if it is safe, bug-free, and behaviour-preserving.",
  criteria: {
    true: "introduces a bug or regression",
    false: "safe and behaviour-preserving",
  },
};

export const KIND_QUESTION: ChoiceQuestion = {
  type: "choice",
  instructions: "Which bug class best categorizes the defect in this code?",
  criteria: BUG_CLASSES,
};

export const KIND_OR_NONE_QUESTION: ChoiceQuestion = {
  type: "choice",
  instructions:
    "Which bug class best categorizes the defect, or 'none' if the change is safe?",
  criteria: {
    ...BUG_CLASSES,
    none: "no bug introduced; behaviour is preserved",
  },
};

export const TRIAGE_QUESTION: ChoiceQuestion = {
  type: "choice",
  instructions: "What is the primary cause of this CI failure?",
  criteria: {
    regression:
      "a regression caused by recent code changes failing an existing assertion",
    flaky:
      "a flaky or intermittent test that failed and passed on retry, unrelated to the PR",
    environment:
      "an infrastructure, runner, disk space, or container setup error",
    "test-bug":
      "an incorrect test modification in the PR with wrong expected values",
  },
};

const LEVELS: TextLevel[] = [
  {
    id: "gate",
    title: "Review gate",
    description:
      "Does this pull request introduce a bug or is it a safe, behaviour-preserving refactor? Scored on test-proven mutants.",
    questions: { bug: BUG_QUESTION },
  },
  {
    id: "locate",
    title: "Find the line",
    description:
      "Given the function and a failing test, identify the exact line number where the defect is located.",
    questions: {}, // dynamically filled from case options
  },
  {
    id: "kind",
    title: "Bug class",
    description:
      "Given a failing function and test case, classify the bug into off-by-one, wrong-operator, inverted-condition, wrong-variable, missing-guard, or missing-update.",
    questions: { kind: KIND_QUESTION },
  },
  {
    id: "returns",
    title: "What it returns",
    description:
      "Predict what a TypeScript function returns for a specific call, distinguishing the true outcome from plausible mutants.",
    questions: {}, // dynamically filled from case options
  },
  {
    id: "ci",
    title: "CI triage",
    description:
      "Triage CI failures: determine whether a failure is a real regression, flaky test, container/infrastructure issue, or a broken test in the PR.",
    questions: { triage: TRIAGE_QUESTION },
  },
  {
    id: "long",
    title: "Long file",
    description:
      "Review a change across a larger multi-function file. Exceeds standard short token budgets.",
    questions: { bug: BUG_QUESTION },
    tags: ["long-input"],
  },
  {
    id: "all-questions",
    title: "Gate and bug class",
    description:
      "Answer both questions in a single pass: whether the diff is buggy, and if so, its bug class (or 'none').",
    questions: { bug: BUG_QUESTION, kind: KIND_OR_NONE_QUESTION },
    tags: ["many-questions"],
  },
];

function rule(request: Request): Answers {
  const s = request.state as Record<string, unknown> | null;
  const answers: Answers = {};
  const q = request.questions;

  const diff = typeof s?.diff === "string" ? s.diff : "";
  const ciLog = Array.isArray(s?.ci_log)
    ? (s.ci_log as string[]).join("\n")
    : "";
  const failing =
    (s?.failing_test as { call?: string } | undefined)?.call ?? "";

  // 1. Bug question (gate, long, all-questions)
  if (q.bug) {
    const isSuspicious =
      /[+-]\s*.*(\bfor\b|\bwhile\b|<=|>=|<|>|Math\.(min|max)|\.length\s*[-+]\s*1|===|!==)/.test(
        diff,
      ) || /-\s*(if\s*\(|return\s*|throw\s*)/.test(diff);
    answers.bug = { type: "noul", noul: isSuspicious ? 0.85 : 0.15 };
  }

  // 2. Line question (locate)
  if (q.line?.type === "choice") {
    const options = Object.keys(q.line.criteria);
    // Try to find line from stack trace or diff
    const match = failing.match(/:(\d+):\d+/);
    const lineCandidate = match?.[1];
    const choice =
      lineCandidate && options.includes(lineCandidate)
        ? lineCandidate
        : (options[Math.floor(options.length / 2)] ?? options[0] ?? "1");

    answers.line = {
      type: "choice",
      choice,
      probabilities: Object.fromEntries(
        options.map((k) => [k, k === choice ? 1 : 0]),
      ),
    };
  }

  // 3. Kind question (kind, all-questions)
  if (q.kind?.type === "choice") {
    let choice: string = "wrong-operator";
    if (
      "none" in q.kind.criteria &&
      answers.bug?.type === "noul" &&
      answers.bug.noul < 0.5
    ) {
      choice = "none";
    } else if (/<=|>=|<|>|\.length\s*[-+]\s*1|\b0\b.*\b1\b/.test(diff)) {
      choice = "off-by-one";
    } else if (/===|!==|!\s*\(/.test(diff)) {
      choice = "inverted-condition";
    } else if (/Math\.(min|max)|\+|-|\*|\/|&&|\|\|/.test(diff)) {
      choice = "wrong-operator";
    } else if (/-\s*if\s*\(/.test(diff)) {
      choice = "missing-guard";
    } else if (/-\s*\w+(\+\+|--|\s*[+\-*/]=)/.test(diff)) {
      choice = "missing-update";
    } else {
      choice = "wrong-variable";
    }

    if (!Object.hasOwn(q.kind.criteria, choice)) {
      choice = Object.keys(q.kind.criteria)[0] ?? "wrong-operator";
    }

    answers.kind = {
      type: "choice",
      choice,
      probabilities: Object.fromEntries(
        Object.keys(q.kind.criteria).map((k) => [k, k === choice ? 1 : 0]),
      ),
    };
  }

  // 4. Returns question
  if (q.returns?.type === "choice") {
    const options = Object.keys(q.returns.criteria);
    const choice = options[0] ?? "undefined";
    answers.returns = {
      type: "choice",
      choice,
      probabilities: Object.fromEntries(
        options.map((k) => [k, k === choice ? 1 : 0]),
      ),
    };
  }

  // 5. CI triage question
  if (q.triage?.type === "choice") {
    let choice: string = "regression";
    if (/ENOSPC|ECONNREFUSED|Runner failed|Worker process/.test(ciLog)) {
      choice = "environment";
    } else if (/retry|flaky|TimeoutError|passed on retry/i.test(ciLog)) {
      choice = "flaky";
    } else if (/\+\s*expect\(.*\.toBe\(/.test(diff)) {
      choice = "test-bug";
    } else {
      choice = "regression";
    }

    answers.triage = {
      type: "choice",
      choice,
      probabilities: Object.fromEntries(
        Object.keys(q.triage.criteria).map((k) => [k, k === choice ? 1 : 0]),
      ),
    };
  }

  return answers;
}

export const review = textDungeon({
  id: "review",
  title: "Code review",
  description:
    "Evaluate TypeScript pull requests, localizations, and test outputs: gate buggy diffs, locate flawed lines, classify bugs, and triage CI runs.",
  levels: LEVELS,
  state: (c: TextCase) => c.input,
  questions: (c: TextCase, level: TextLevel): Record<string, Question> => {
    if (level.id === "locate") {
      const inp = c.input as Record<string, unknown>;
      const options = Array.isArray(inp.options)
        ? (inp.options as string[])
        : [];
      return {
        line: {
          type: "choice",
          instructions:
            "Which line number in the code contains the bug or mutation?",
          criteria: Object.fromEntries(options.map((o) => [o, null])),
        },
      };
    }
    if (level.id === "returns") {
      const inp = c.input as Record<string, unknown>;
      const options = Array.isArray(inp.options)
        ? (inp.options as string[])
        : [];
      return {
        returns: {
          type: "choice",
          instructions: "What does this TypeScript function call evaluate to?",
          criteria: Object.fromEntries(options.map((o) => [o, null])),
        },
      };
    }
    return level.questions;
  },
  rule,
  summary: (c: TextCase) => {
    const s = c.input as Record<string, unknown>;
    if (typeof s.pr === "number") return `PR #${s.pr} (${s.file ?? "code"})`;
    if (typeof s.file === "string") return `${s.file}`;
    return `Case ${c.id}`;
  },
});
