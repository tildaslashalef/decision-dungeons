// "Under the hood": the live JSON of each decision (the request as the
// decider received it, the full decision state, the response, what the car
// perceives), refreshed four times a second unless frozen. Copy and
// download take exactly what is on screen.

import { Braces, Copy, Download, X } from "lucide";
import { h, icon } from "../../../ui/dom.ts";

export type InspectorTab = "request" | "state" | "decision" | "perception";

const TABS: [InspectorTab, string, string][] = [
  [
    "request",
    "Decider input",
    "The exact request the decider received, after its own rewrite: offered choices, instructions, and the state.",
  ],
  [
    "state",
    "Decision state",
    "Everything the car knew when it planned: candidates and their rollouts, road edges, traffic, signals, stop memory.",
  ],
  [
    "decision",
    "Response",
    "The decider's answers with their probabilities, timings, and tokens, and the maneuver they chose.",
  ],
  [
    "perception",
    "Perception",
    "What the sensors see right now: objects in range, occlusion by buildings, and every object discovered so far.",
  ],
];

const TOKEN =
  /("(?:\\.|[^"\\])*"\s*:?)|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/g;

/** JSON as highlighted spans; text goes in as text, never as markup. */
function highlight(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let at = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > at) fragment.append(text.slice(at, index));
    const token = match[0];
    const cls = token.startsWith('"')
      ? token.trimEnd().endsWith(":")
        ? "json-key"
        : "json-string"
      : /^(true|false|null)$/.test(token)
        ? "json-bool"
        : "json-number";
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = token;
    fragment.append(span);
    at = index + token.length;
  }
  if (at < text.length) fragment.append(text.slice(at));
  return fragment;
}

export class Inspector {
  readonly dialog: HTMLDialogElement;
  tab: InspectorTab = "request";
  private frozen = false;
  private content: HTMLPreElement;
  private description: HTMLParagraphElement;
  private live: HTMLSpanElement;
  private freeze: HTMLButtonElement;
  private copyLabel: HTMLSpanElement;
  private tabs = new Map<InspectorTab, HTMLButtonElement>();
  private lastRender = 0;

  constructor(
    private readonly data: (tab: InspectorTab) => unknown,
    private readonly filename: (tab: InspectorTab) => string,
  ) {
    this.content = h("pre", { class: "json-content" });
    this.description = h("p", { class: "json-description" });
    this.live = h("span", { class: "json-live" }, "LIVE · 4 Hz");
    this.freeze = h(
      "button",
      { type: "button", onclick: () => this.setFrozen(!this.frozen) },
      "Freeze",
    );
    this.copyLabel = h("span", { "aria-live": "polite" }, "Copy");
    const tabButtons = TABS.map(([id, title]) => {
      const button = h(
        "button",
        {
          type: "button",
          class: id === this.tab ? "active" : "",
          onclick: () => this.select(id),
        },
        title,
      );
      this.tabs.set(id, button);
      return button;
    });
    this.dialog = h(
      "dialog",
      { class: "json-dialog", "aria-label": "Live JSON inspector" },
      h(
        "div",
        { class: "json-header" },
        h(
          "div",
          {},
          icon(Braces),
          h("strong", {}, "Under the hood"),
          this.live,
        ),
        h(
          "button",
          {
            type: "button",
            "aria-label": "Close JSON inspector",
            onclick: () => this.dialog.close(),
          },
          icon(X),
        ),
      ),
      h(
        "div",
        { class: "json-toolbar" },
        h("div", { class: "json-tabs", role: "tablist" }, tabButtons),
        h(
          "div",
          { class: "json-actions" },
          this.freeze,
          h(
            "button",
            {
              type: "button",
              "aria-label": "Copy displayed JSON",
              onclick: () => void this.copy(),
            },
            icon(Copy),
            this.copyLabel,
          ),
          h(
            "button",
            { type: "button", onclick: () => this.download() },
            icon(Download),
            "Download",
          ),
        ),
      ),
      this.description,
      this.content,
    );
    this.syncDescription();
  }

  open(): void {
    this.dialog.showModal();
    this.render(true);
  }

  private select(tab: InspectorTab): void {
    this.tab = tab;
    for (const [id, button] of this.tabs)
      button.classList.toggle("active", id === tab);
    this.setFrozen(false);
    this.syncDescription();
    this.render(true);
  }

  private syncDescription(): void {
    this.description.textContent =
      TABS.find(([id]) => id === this.tab)?.[2] ?? "";
  }

  private setFrozen(frozen: boolean): void {
    this.frozen = frozen;
    this.freeze.textContent = frozen ? "Resume" : "Freeze";
    this.live.textContent = frozen ? "FROZEN" : "LIVE · 4 Hz";
  }

  /** Re-renders at most four times a second while open, unless forced. */
  render(force = false): void {
    if (!this.dialog.open || this.frozen) return;
    const now = performance.now();
    if (!force && now - this.lastRender < 250) return;
    this.lastRender = now;
    const text = JSON.stringify(this.data(this.tab), null, 2) ?? "null";
    this.content.replaceChildren(highlight(text));
  }

  private async copy(): Promise<void> {
    const text = this.content.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      this.copyLabel.textContent = "Copied!";
    } catch {
      this.setFrozen(true);
      const range = document.createRange();
      range.selectNodeContents(this.content);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      this.copyLabel.textContent = "Press ⌘C / Ctrl+C";
    }
    setTimeout(() => {
      this.copyLabel.textContent = "Copy";
    }, 3000);
  }

  private download(): void {
    const text = this.content.textContent ?? "";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([text], { type: "application/json" }),
    );
    a.download = this.filename(this.tab);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
