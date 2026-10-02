// Logs: ten-minute windows from Harborline's production services. Decide
// whether to page on-call, hold per-minute numbers against a paging
// policy, name the root cause, and find an incident at the end of a long
// window. Cases come from a case set (generate.ts writes them).

import type { Answers } from "../../contract/answer.ts";
import type { Request } from "../../contract/request.ts";
import type { TextCase } from "../text/cases.ts";
import { type TextLevel, textDungeon } from "../text/text-dungeon.ts";
import { ERROR_SHARE_LIMIT, type LogWindow, P95_LIMIT_MS } from "./generate.ts";

const PAGE = {
  type: "noul" as const,
  instructions:
    "Should on-call be paged now? Page for user-facing failures still happening at the end of the window: sustained errors, crash loops, a full disk, a dead dependency. Do not page for noise: a single error, a retry that succeeded, a rollout's startup, scanners, warnings, or a problem that already recovered.",
  criteria: { true: "page now", false: "no page" },
};

const BREACH = {
  type: "noul" as const,
  instructions:
    "Apply the window's paging policy to the per-minute metrics: does any minute breach it?",
  criteria: {
    true: "at least one minute breaches",
    false: "every minute is within the policy",
  },
};

const CAUSE = {
  type: "choice" as const,
  instructions: "What is the most likely root cause of this incident?",
  criteria: {
    database: "the database: pool exhaustion, deadlocks, failover, read-only",
    deploy: "a code change just rolled out",
    dependency: "an outside service the system calls",
    resources: "memory, disk, or CPU of the service itself",
    network: "DNS, connections, or routing between services",
  },
};

/** The cause, or that there is nothing to page for: asked beside `page`. */
const CAUSE_OR_NONE = {
  type: "choice" as const,
  instructions:
    "What is the most likely root cause of the incident in this window? If there is no incident to page for, answer none.",
  criteria: {
    ...CAUSE.criteria,
    none: "no incident to page for: noise, a blip, a retry, or a problem that already recovered",
  },
};

const LEVELS: TextLevel[] = [
  {
    id: "incident",
    title: "Page or not",
    description:
      "Real incidents against blips, retries, rollouts, scanners, and problems that already recovered. Pass with 90% right.",
    questions: { page: PAGE },
  },
  {
    id: "thresholds",
    title: "Numbers against a policy",
    description: `Per-minute metrics: page if any minute's 5xx share passes ${ERROR_SHARE_LIMIT}% or its p95 passes ${P95_LIMIT_MS} ms. Many minutes sit just under.`,
    questions: { breach: BREACH },
  },
  {
    id: "root-cause",
    title: "Root cause",
    description:
      "Every window is an incident: database, deploy, dependency, resources, or network, sometimes with a red herring.",
    questions: { cause: CAUSE },
  },
  {
    id: "long",
    title: "Long windows",
    description:
      "Three hundred lines of healthy noise; when there is an incident, it starts in the last minute. Past a short model's budget.",
    questions: { page: PAGE },
    tags: ["long-input"],
  },
  {
    id: "all-questions",
    title: "Page and cause",
    description:
      "Both questions about every window in one request: page or not, and the root cause or none. A window is right only when both are.",
    questions: { page: PAGE, cause: CAUSE_OR_NONE },
    tags: ["many-questions"],
  },
];

const asWindow = (request: Request): LogWindow => {
  const s = request.state;
  if (
    !s ||
    typeof s !== "object" ||
    Array.isArray(s) ||
    !Array.isArray(s.lines)
  )
    throw new Error("the state is not a log window");
  return s as unknown as LogWindow;
};

const ALARM =
  /no space left|oomkilled|back-off restarting|circuit breaker open|deadlock|read-only transaction|timeout acquiring connection .*max=|i\/o timeout|connection reset|cannot read properties/i;
const CLEAR =
  /circuit breaker closed|retry succeeded|readiness probe passed|pods ready/i;

/** Whether the window ends in trouble: alarms or 5xx in its last third, and no recovery after them. */
function shouldPage(lines: string[]): boolean {
  const tail = lines.slice(Math.floor(lines.length * (2 / 3)));
  const bad = tail.filter(
    (l) => ALARM.test(l) || /\s5\d\d\s\d+ms$/.test(l),
  ).length;
  const lastBad = lines.findLastIndex(
    (l) => ALARM.test(l) || /\s5\d\d\s\d+ms$/.test(l),
  );
  const lastClear = lines.findLastIndex((l) => CLEAR.test(l));
  return bad >= 3 && lastBad > lastClear;
}

function breaches(lines: string[]): boolean {
  return lines.some((line) => {
    const n = (key: string) =>
      Number(line.match(new RegExp(`${key}=(\\d+)`))?.[1]);
    const requests = n("requests");
    return (
      (requests > 0 &&
        (n("errors_5xx") / requests) * 100 > ERROR_SHARE_LIMIT) ||
      n("p95_ms") > P95_LIMIT_MS
    );
  });
}

function cause(lines: string[]): string {
  const text = lines.join("\n").toLowerCase();
  if (/oomkilled|no space left|back-off restarting/.test(text))
    return "resources";
  if (/lookup .* i\/o timeout|connection reset/.test(text)) return "network";
  if (/circuit breaker open|503 service unavailable/.test(text))
    return "dependency";
  if (/pool primary|deadlock|read-only transaction|pgbouncer/.test(text))
    return "database";
  if (/rolled out/.test(text)) return "deploy";
  return "dependency";
}

function rule(request: Request): Answers {
  const w = asWindow(request);
  const answers: Answers = {};
  const q = request.questions;
  if (q.page)
    answers.page = { type: "noul", noul: shouldPage(w.lines) ? 0.9 : 0.1 };
  if (q.breach)
    answers.breach = { type: "noul", noul: breaches(w.lines) ? 0.99 : 0.01 };
  if (q.cause?.type === "choice") {
    const choice =
      "none" in q.cause.criteria && !shouldPage(w.lines)
        ? "none"
        : cause(w.lines);
    answers.cause = {
      type: "choice",
      choice,
      probabilities: Object.fromEntries(
        Object.keys(q.cause.criteria).map((k) => [k, k === choice ? 1 : 0]),
      ),
    };
  }
  return answers;
}

export const logs = textDungeon({
  id: "logs",
  title: "Logs",
  description:
    "Production log windows: page or not, numbers against a paging policy, root causes, and incidents at the end of long windows. Known answers, scored per window.",
  levels: LEVELS,
  state: (c: TextCase) => c.input,
  rule,
  summary: (c: TextCase) => {
    const w = c.input as unknown as LogWindow;
    return `${w.service} ${w.window}`;
  },
});
