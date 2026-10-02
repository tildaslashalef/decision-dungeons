// The debug sidebar (N): what the decider read and answered for each
// decision. It shows only what the decider reported; a missing field is
// left out, never shown as zero.

import type { Answer, Decision } from "../contract/answer.ts";
import type { Question } from "../contract/request.ts";
import { type Child, h, ms, percent, replace } from "./dom.ts";
import { svgIcon } from "./icons.ts";
import type { DebugEntry, Store } from "./store.ts";

export function answerSummary(answer: Answer | undefined): string {
  if (!answer) return "—";
  switch (answer.type) {
    case "choice": {
      const p = answer.probabilities?.[answer.choice];
      return p === undefined ? answer.choice : `${answer.choice} ${percent(p)}`;
    }
    case "score":
      return `score ${answer.score.toFixed(2)}`;
    case "noul":
      return `P ${answer.noul.toFixed(2)}`;
  }
}

function timeline(entry: DebugEntry, decision: Decision): Child {
  const t = decision.timings;
  const inside = (t.load ?? 0) + (t.tokenize ?? 0) + (t.encode ?? 0);
  const segments: [string, number | undefined, string][] = [
    ["load", t.load, "t-load"],
    ["tokenize", t.tokenize, "t-tokenize"],
    ["encode", t.encode, "t-encode"],
    // Process start, I/O, and anything the decider did not break down.
    ["rest of the decider", Math.max(0, t.total - inside), "t-process"],
    [
      "HTTP and server",
      entry.roundTripMs === undefined
        ? undefined
        : Math.max(0, entry.roundTripMs - t.total),
      "t-http",
    ],
  ];
  const whole = Math.max(1, entry.roundTripMs ?? t.total);
  return h(
    "div",
    { class: "debug-timeline", "aria-label": "Time split" },
    segments.map(([label, value, cls]) =>
      value && value > 0
        ? h("span", {
            class: cls,
            style: `width:${(100 * value) / whole}%`,
            title: `${label} ${ms(value)}`,
          })
        : null,
    ),
  );
}

function facts(entry: DebugEntry, decision: Decision): Child {
  const rows: [string, Child][] = [];
  const t = decision.timings;
  if (t.load !== undefined) rows.push(["load", ms(t.load)]);
  if (t.tokenize !== undefined) rows.push(["tokenize", ms(t.tokenize)]);
  if (t.encode !== undefined) rows.push(["encode", ms(t.encode)]);
  rows.push(["decider", ms(t.total)]);
  if (entry.roundTripMs !== undefined)
    rows.push(["round trip", ms(entry.roundTripMs)]);
  if (decision.usage)
    rows.push([
      "tokens",
      `${decision.usage.inputTokens} in, ${decision.usage.outputTokens} out`,
    ]);
  const d = decision.debug;
  if (d?.stateTokens !== undefined)
    rows.push([
      "state",
      [`${d.stateTokens} tokens`, d.truncated ? h("em", {}, " cut") : null],
    ]);
  if (decision.costUsd !== undefined)
    rows.push([
      "cost",
      decision.costUsd === 0 ? "$0" : `$${decision.costUsd.toFixed(6)}`,
    ]);
  return h(
    "dl",
    { class: "debug-facts" },
    rows.map(([label, value]) => [h("dt", {}, label), h("dd", {}, value)]),
  );
}

function option(
  key: string,
  description: string | null | undefined,
  p: number | undefined,
  logit: number | undefined,
  chosen: boolean,
): HTMLElement {
  return h(
    "li",
    { class: chosen ? "chosen" : "" },
    h(
      "div",
      { class: "debug-option" },
      h("b", {}, key),
      h("span", {}, p === undefined ? "" : percent(p)),
      h("small", {}, logit === undefined ? "" : logit.toFixed(2)),
    ),
    p === undefined
      ? null
      : h(
          "div",
          { class: "debug-bar" },
          h("span", { style: `width:${Math.max(1, p * 100)}%` }),
        ),
    description ? h("p", { title: description }, description) : null,
  );
}

function question(
  id: string,
  q: Question,
  answer: Answer | undefined,
): HTMLElement {
  const debug = answer?.debug;
  let options: HTMLElement[] = [];
  if (q.type === "choice") {
    const chosen = answer?.type === "choice" ? answer : undefined;
    options = Object.entries(q.criteria).map(([key, description], i) =>
      option(
        key,
        description,
        chosen?.probabilities?.[key],
        debug?.logits?.[i],
        chosen?.choice === key,
      ),
    );
  } else if (q.type === "score") {
    const scored = answer?.type === "score" ? answer : undefined;
    const nearest = scored ? Math.round(scored.score) : -1;
    options = q.criteria.map((level, i) =>
      option(
        String(i),
        level,
        scored?.probabilities?.[String(i)],
        debug?.logits?.[i],
        i === nearest,
      ),
    );
  } else {
    const p = answer?.type === "noul" ? answer.noul : undefined;
    options = [
      option(
        "false",
        q.criteria?.false,
        p === undefined ? p : 1 - p,
        debug?.logits?.[0],
        p !== undefined && p < 0.5,
      ),
      option(
        "true",
        q.criteria?.true,
        p,
        debug?.logits?.[1],
        p !== undefined && p >= 0.5,
      ),
    ];
  }
  const meta = [
    debug?.bucket ?? q.type,
    debug?.temperature !== undefined
      ? `T ${debug.temperature.toFixed(2)}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return h(
    "section",
    { class: "debug-section" },
    h(
      "div",
      { class: "debug-heading" },
      h("b", {}, id),
      h("span", {}, `${answerSummary(answer)} · ${meta}`),
    ),
    debug?.tokensRead !== undefined
      ? h(
          "p",
          { class: "debug-note" },
          `${debug.tokensRead} tokens read${debug.stateKept !== undefined ? `, ${debug.stateKept} of the state` : ""}`,
        )
      : null,
    h("ol", { class: "debug-options" }, options),
    h(
      "details",
      {},
      h("summary", {}, "Instructions"),
      h("p", {}, q.instructions),
    ),
  );
}

function latest(entry: DebugEntry): Child {
  const { decision, error } = entry;
  const request = decision?.debug?.request ?? entry.request;
  const heading = h(
    "div",
    { class: "debug-heading" },
    h("b", {}, `Decision #${entry.id}`),
    h(
      "span",
      {},
      decision
        ? `${decision.decider} · ${decision.model}`
        : error
          ? error.code
          : "deciding…",
    ),
  );
  if (!decision)
    return h(
      "section",
      { class: "debug-section" },
      heading,
      error ? h("p", { class: "debug-error" }, error.message) : null,
    );
  return [
    h(
      "section",
      { class: "debug-section" },
      heading,
      timeline(entry, decision),
      facts(entry, decision),
    ),
    Object.entries(request.questions).map(([id, q]) =>
      question(id, q, decision.answers[id]),
    ),
  ];
}

function history(entries: DebugEntry[]): HTMLElement {
  return h(
    "section",
    { class: "debug-section" },
    h("div", { class: "debug-heading" }, h("b", {}, "Recent decisions")),
    h(
      "ol",
      { class: "debug-log" },
      entries.map((e) => {
        const first = e.decision
          ? Object.values(e.decision.answers)[0]
          : undefined;
        return h(
          "li",
          { class: e.error ? "error" : "" },
          h("span", {}, `#${e.id}`),
          h("span", {}, e.time),
          h(
            "span",
            {},
            e.error
              ? e.error.message
              : e.decision
                ? answerSummary(first)
                : "deciding…",
          ),
          h("span", {}, e.decision ? ms(e.decision.timings.total) : ""),
        );
      }),
    ),
  );
}

export function debugSidebar(store: Store): HTMLElement {
  const body = h("div", { class: "debug-body" });
  const root = h(
    "aside",
    { class: "debug-sidebar glass", "aria-label": "Decision debug" },
    h(
      "div",
      { class: "debug-header" },
      h("strong", {}, "Debug"),
      h("span", {}, "what the decider read and answered"),
      h("kbd", {}, "N"),
      h(
        "button",
        {
          type: "button",
          "aria-label": "Close debug",
          onclick: () => store.set({ debugOpen: false }),
        },
        svgIcon("close"),
      ),
    ),
    body,
  );
  const render = () => {
    const { debug, debugOpen } = store.get();
    root.hidden = !debugOpen;
    if (!debugOpen) return;
    const [first] = debug;
    replace(
      body,
      first
        ? latest(first)
        : h("p", { class: "debug-empty" }, "Play to see each decision."),
      debug.length ? history(debug) : null,
    );
  };
  store.subscribe((state, previous) => {
    if (
      state.debug !== previous.debug ||
      state.debugOpen !== previous.debugOpen
    )
      render();
  });
  render();
  return root;
}
