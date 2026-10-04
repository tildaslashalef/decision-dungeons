// The text dungeons in the browser: the case as a person would see it (an
// email, a ticket, a log window, a receipt) beside the questions, the decider's
// answers, the known answers, and why. Every case's result runs along the
// bottom.

import type { Answer } from "../../contract/answer.ts";
import { caseStrip, shownCase } from "../../ui/browse.ts";
import { type Child, h } from "../../ui/dom.ts";
import type { PlayStatus } from "../../ui/store.ts";
import type { Browse } from "../../ui/views.ts";
import type { Email } from "../inbox/generate.ts";
import type { LogWindow } from "../logs/generate.ts";
import { printed, type ReceiptInput, SYMBOLS } from "../receipts/generate.ts";
import { dungeonById } from "../registry.ts";
import type { Ticket } from "../tickets/generate.ts";
import type { TextCase, Truth } from "./cases.ts";
import { answerValue, type TextRun } from "./text-dungeon.ts";

export type Document = "email" | "ticket" | "logs" | "receipt" | "code";

const row = (label: string, value: Child, cls = "") =>
  h(
    "div",
    { class: `doc-row ${cls}` },
    h("span", {}, label),
    h("b", {}, value),
  );

function email(e: Email): HTMLElement {
  return h(
    "article",
    { class: "doc doc-email" },
    h(
      "header",
      {},
      h("h3", {}, e.subject),
      row("From", e.from),
      e.reply_to ? row("Reply-To", e.reply_to, "doc-flag") : null,
      row("To", e.to),
      row("Date", e.date),
      h(
        "div",
        { class: "doc-chips" },
        Object.entries(e.authentication).map(([k, v]) =>
          h(
            "span",
            { class: `chip ${v === "pass" ? "ok" : "bad"}` },
            `${k.toUpperCase()} ${v}`,
          ),
        ),
      ),
    ),
    h("div", { class: "doc-body" }, e.body),
    e.links?.length
      ? h(
          "ul",
          { class: "doc-links" },
          e.links.map((l) =>
            h("li", {}, h("b", {}, l.text), h("code", {}, l.url)),
          ),
        )
      : null,
    e.attachments?.length
      ? h(
          "div",
          { class: "doc-chips" },
          e.attachments.map((a) =>
            h("span", { class: "chip" }, `📎 ${a.name} · ${a.size_kb} KB`),
          ),
        )
      : null,
  );
}

function ticket(t: Ticket): HTMLElement {
  return h(
    "article",
    { class: "doc doc-ticket" },
    h(
      "header",
      {},
      h("h3", {}, t.subject),
      row(
        "Ticket",
        `${t.ticket} · ${t.channel} · ${t.received.replace("T", " ").replace("Z", " UTC")}`,
      ),
      row(
        "Customer",
        `${t.customer.name}, ${t.customer.company} · ${t.customer.plan}, ${t.customer.seats} seats`,
      ),
    ),
    h("div", { class: "doc-body" }, t.message),
  );
}

function logs(w: LogWindow): HTMLElement {
  return h(
    "article",
    { class: "doc doc-logs" },
    h(
      "header",
      {},
      h("h3", {}, `${w.service} · ${w.environment}`),
      row("Window", w.window),
      w.policy ? row("Policy", w.policy, "doc-flag") : null,
      row("Lines", String(w.lines.length)),
    ),
    h(
      "ol",
      { class: "doc-lines" },
      w.lines.map((line) =>
        h(
          "li",
          {
            class: /\sERROR\s/.test(line)
              ? "error"
              : /\sWARN\s/.test(line)
                ? "warn"
                : "",
          },
          line,
        ),
      ),
    ),
  );
}

const shown = (value: Truth | undefined) =>
  value === undefined
    ? "—"
    : value === true
      ? "yes"
      : value === false
        ? "no"
        : String(value);

function given(answer: Answer | undefined): string {
  if (!answer) return "—";
  if (answer.type === "noul")
    return `${shown(answerValue(answer))} (${Math.round(answer.noul * 100)}%)`;
  if (answer.type === "score")
    return `${shown(answerValue(answer))} (${answer.score.toFixed(2)})`;
  const p = answer.probabilities?.[answer.choice];
  return p === undefined
    ? answer.choice
    : `${answer.choice} (${Math.round(p * 100)}%)`;
}

/** What the autopilot was given at each kind of level, for the caption. */
const SHOWN = {
  only: "the picture only",
  "with-text": "the picture and the data",
  text: "the data only, as JSON",
};

/** The slip as the person watching sees it, captioned with what the autopilot got. */
function receipt(c: TextCase, level: string): HTMLElement {
  const { receipt: r } = c.input as unknown as ReceiptInput;
  const images = dungeonById("receipts")?.levels.find(
    (l) => l.id === level,
  )?.images;
  return h(
    "article",
    { class: "doc doc-receipt" },
    h(
      "header",
      {},
      h("h3", {}, r.merchant),
      row("Charged", `${printed(r.total, r.currency)} · ${r.payment}`),
      row("Autopilot", `sees ${SHOWN[images ?? "text"]}`),
    ),
    h(
      "div",
      { class: "doc-picture" },
      c.images?.[0]
        ? h("img", {
            src: c.images[0],
            alt: `The ${r.merchant} receipt, ${SYMBOLS[r.currency]}${r.total.toFixed(2)}`,
          })
        : h("p", {}, "No picture in this case set."),
    ),
  );
}

function codeDoc(c: TextCase): HTMLElement {
  const inp = c.input as Record<string, unknown>;
  const title =
    typeof inp.title === "string"
      ? inp.title
      : typeof inp.file === "string"
        ? inp.file
        : "TypeScript Code";

  const rows: (HTMLElement | null)[] = [];
  if (typeof inp.pr === "number") rows.push(row("PR", `#${inp.pr}`));
  if (typeof inp.file === "string") rows.push(row("File", inp.file));
  if (typeof inp.branch === "string") rows.push(row("Branch", inp.branch));
  if (typeof inp.author === "string") rows.push(row("Author", inp.author));
  if (typeof inp.description === "string")
    rows.push(row("Summary", inp.description));

  const content: HTMLElement[] = [];

  const failingTest = inp.failing_test as
    | { call?: string; expected?: string; actual?: string }
    | undefined;
  if (failingTest) {
    content.push(
      h(
        "div",
        { class: "doc-test-card" },
        h("div", {}, h("b", {}, "Failing Test: "), failingTest.call ?? ""),
        h("div", {}, h("span", {}, "Expected: "), failingTest.expected ?? ""),
        h("div", {}, h("span", {}, "Actual: "), failingTest.actual ?? ""),
      ),
    );
  }

  if (typeof inp.call === "string") {
    content.push(
      h(
        "div",
        { class: "doc-test-card" },
        h("div", {}, h("b", {}, "Evaluate: "), inp.call),
      ),
    );
  }

  if (typeof inp.diff === "string") {
    const lines = inp.diff.split("\n");
    content.push(
      h(
        "pre",
        { class: "doc-code doc-diff" },
        lines.map((line) => {
          const cls = line.startsWith("+")
            ? "diff-add"
            : line.startsWith("-")
              ? "diff-del"
              : line.startsWith("@@")
                ? "diff-hunk"
                : "";
          return h("span", { class: cls }, `${line}\n`);
        }),
      ),
    );
  } else if (typeof inp.code_with_line_numbers === "string") {
    content.push(h("pre", { class: "doc-code" }, inp.code_with_line_numbers));
  } else if (typeof inp.code === "string") {
    content.push(h("pre", { class: "doc-code" }, inp.code));
  }

  if (Array.isArray(inp.ci_log)) {
    content.push(
      h(
        "ol",
        { class: "doc-lines doc-ci" },
        (inp.ci_log as string[]).map((line) =>
          h(
            "li",
            {
              class: /FAIL|Error:|TimeoutError/i.test(line)
                ? "error"
                : /Warning:|flaky/i.test(line)
                  ? "warn"
                  : "",
            },
            line,
          ),
        ),
      ),
    );
  }

  return h(
    "article",
    { class: "doc doc-code-article" },
    h("header", {}, h("h3", {}, title), ...rows),
    ...content,
  );
}

function document(kind: Document, c: TextCase, level: string): HTMLElement {
  if (kind === "email") return email(c.input as unknown as Email);
  if (kind === "ticket") return ticket(c.input as unknown as Ticket);
  if (kind === "receipt") return receipt(c, level);
  if (kind === "code") return codeDoc(c);
  return logs(c.input as unknown as LogWindow);
}

/** While a decision is out, the case being asked; otherwise the one just answered, with its result. */
export function textView(
  kind: Document,
  run: TextRun,
  status: PlayStatus,
  browse: Browse = {},
): HTMLElement {
  const { index, answered } = shownCase(
    run.index,
    run.cases.length,
    status,
    browse,
  );
  const c = run.cases[index];
  if (!c) return h("div", {});
  const record = answered ? run.records[index] : undefined;
  const answers = answered ? run.answers[index] : undefined;
  return h(
    "div",
    { class: "text-case" },
    h(
      "div",
      { class: "crossing-head" },
      h(
        "span",
        { class: "eyebrow" },
        `Case ${index + 1} of ${run.cases.length} · ${c.lang} · set ${run.set.name}`,
      ),
      record
        ? h(
            "span",
            { class: `verdict ${record.correct ? "ok" : "bad"}` },
            record.correct ? "Correct" : "Wrong",
          )
        : h(
            "span",
            { class: "verdict pending" },
            status === "deciding"
              ? "Deciding…"
              : status === "failed"
                ? "No answer"
                : "Up next",
          ),
    ),
    h(
      "div",
      { class: "text-grid" },
      document(kind, c, run.level),
      h(
        "aside",
        { class: "text-answers" },
        Object.entries(c.truth).map(([id, truth]) =>
          h(
            "div",
            { class: "facts" },
            h(
              "div",
              { class: "fact" },
              h("span", {}, "Question"),
              h("b", {}, id),
            ),
            h(
              "div",
              { class: "fact" },
              h("span", {}, "Answer"),
              h("b", {}, answered ? given(answers?.[id]) : "—"),
            ),
            h(
              "div",
              { class: "fact" },
              h("span", {}, "Expected"),
              h("b", {}, answered ? shown(truth) : "—"),
            ),
          ),
        ),
        answered
          ? h("p", { class: "text-why" }, h("b", {}, "Why: "), c.why)
          : null,
      ),
    ),
    caseStrip(
      run.cases.length,
      index,
      (i) => {
        const r = run.records[i];
        return r ? (r.correct ? "ok" : "bad") : "";
      },
      (i) => run.records[i]?.summary ?? `Case ${i + 1}`,
      browse,
    ),
  );
}
