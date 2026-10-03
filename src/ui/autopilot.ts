// The autopilot picker: every decider and its models, the unusable ones
// shown disabled with the reason. Used by the start screen and the config page.

import type { Autopilot, DeciderView } from "../contract/api.ts";
import { h } from "./dom.ts";
import { type IconName, svgIcon } from "./icons.ts";

const DECIDER_ICONS: Record<string, IconName> = {
  nuclis: "atom",
  cascade: "stack",
  typesafe: "cloud",
  rule: "ruleBook",
  random: "dice",
};

/** The emblem shown beside a decider's name. */
export function deciderIcon(id: string, className = ""): SVGElement {
  return svgIcon(DECIDER_ICONS[id] ?? "torch", className);
}

/** One selectable autopilot: a decider's model, or why it cannot be chosen. */
export interface AutopilotOption extends Autopilot {
  label: string;
  /** Why it is unavailable, when it is. */
  blocked?: string;
}

/** Every decider's models as flat options, unusable ones carrying their reason. */
export function autopilotOptions(deciders: DeciderView[]): AutopilotOption[] {
  return deciders.flatMap((view) => {
    const blocked = deciderBlocked(view);
    if (!view.models.length)
      return [
        {
          decider: view.id,
          model: "",
          label: view.label,
          blocked: blocked ?? "no models",
        },
      ];
    return view.models.map((model) => {
      const why =
        blocked ??
        (model.available ? undefined : (model.reason ?? "unavailable"));
      return {
        decider: view.id,
        model: model.id,
        label: `${view.label} · ${model.label}`,
        ...(why ? { blocked: why } : {}),
      };
    });
  });
}

/** Why this decider cannot run now, or undefined when it can. */
export function deciderBlocked(view: DeciderView): string | undefined {
  if (!view.status.configured) return view.status.reason ?? "not configured";
  if (view.status.reachable === false)
    return view.status.reason ?? "not reachable";
  if (view.modelsError) return view.modelsError;
  if (!view.models.some((m) => m.available)) return "no model is available";
  return undefined;
}

export function usable(
  deciders: DeciderView[] | undefined,
  choice: Autopilot,
): boolean {
  const view = deciders?.find((d) => d.id === choice.decider);
  return (
    !!view &&
    !deciderBlocked(view) &&
    view.models.some((m) => m.id === choice.model && m.available)
  );
}

/** The autopilot every lobby selects unless the settings name another. */
export const PREFERRED_AUTOPILOT: Autopilot = {
  decider: "nuclis",
  model: "laya-multilingual",
};

/**
 * `wanted` (the dungeon's saved default) when usable, else the preferred
 * autopilot, else the first usable one, so a lobby always has one when any
 * decider is ready.
 */
export function defaultAutopilot(
  deciders: DeciderView[],
  wanted?: Autopilot,
): Autopilot | undefined {
  if (wanted && usable(deciders, wanted)) return wanted;
  if (usable(deciders, PREFERRED_AUTOPILOT)) return PREFERRED_AUTOPILOT;
  for (const id of ["rule", "random", "nuclis", "typesafe"]) {
    const view = deciders.find((d) => d.id === id);
    const model = view?.models.find((m) => m.available);
    if (view && model && !deciderBlocked(view))
      return { decider: view.id, model: model.id };
  }
  return undefined;
}

/** A line under a decider's name saying what it is, where its name alone does not. */
const ABOUT: Record<string, string> = {
  rule: "The dungeon's own rules, applied exactly. No model.",
  random: "Picks an option at random: the floor to beat.",
};

/** Where a TypeSafe key comes from. */
const TYPESAFE_CONSOLE = "https://console.typesafe.ai";

/** The nuclis row's mode, kept while the lobby redraws; a cascade choice opens it on Cascade. */
let nuclisMode: "single" | "cascade" | undefined;

export function autopilotPicker(
  deciders: DeciderView[],
  value: Autopilot | undefined,
  onChange: (choice: Autopilot) => void,
  name = "autopilot",
): HTMLElement {
  const cascade = deciders.find((d) => d.id === "cascade");
  const nuclis = deciders.find((d) => d.id === "nuclis");
  if (value?.decider === "cascade") nuclisMode = "cascade";
  else if (value?.decider === "nuclis") nuclisMode = "single";
  const mode = nuclisMode ?? "single";

  const pills = (view: DeciderView) => {
    const blocked = deciderBlocked(view);
    return view.models.map((model) => {
      const disabled = !!blocked || !model.available;
      const checked = value?.decider === view.id && value.model === model.id;
      return h(
        "label",
        {
          class: `pill${checked ? " checked" : ""}${disabled ? " disabled" : ""}`,
          title: disabled
            ? (blocked ?? model.reason ?? "unavailable")
            : model.label,
        },
        h("input", {
          type: "radio",
          name,
          value: `${view.id}/${model.id}`,
          checked,
          disabled,
          onchange: () => onChange({ decider: view.id, model: model.id }),
        }),
        model.label,
      );
    });
  };

  const detail = (view: DeciderView, blocked: string | undefined) => {
    if (view.id === "typesafe")
      return h(
        "small",
        {},
        blocked ??
          (view.status.pricing
            ? `$${view.status.pricing.inputPerMillionUsd} per M input tokens`
            : ""),
        " · ",
        h(
          "a",
          {
            href: TYPESAFE_CONSOLE,
            target: "_blank",
            rel: "noopener noreferrer",
            class: "picker-link",
          },
          "console.typesafe.ai",
        ),
      );
    return h(
      "small",
      {},
      blocked ??
        ABOUT[view.id] ??
        [view.status.version, view.id === "nuclis" ? "local, free" : null]
          .filter(Boolean)
          .join(" · "),
    );
  };

  const row = (view: DeciderView, models: HTMLElement) => {
    const blocked = deciderBlocked(view);
    return h(
      "div",
      { class: `picker-row${blocked ? " blocked" : ""}` },
      h(
        "div",
        { class: "picker-name" },
        deciderIcon(view.id, "picker-icon"),
        h("b", {}, view.label),
        detail(view, blocked),
      ),
      models,
    );
  };

  /** nuclis's one row: its models alone, or as cascades of a fast screener and a slow judge. */
  const nuclisRow = (view: DeciderView, pairs: DeciderView) => {
    const models = h("div", { class: "picker-models" });
    const segment = h("div", {
      class: "segmented",
      role: "group",
      "aria-label": "nuclis mode",
    });
    const pairsBlocked = deciderBlocked(pairs);
    const show = (m: "single" | "cascade") => {
      nuclisMode = m;
      models.replaceChildren(...pills(m === "cascade" ? pairs : view));
      for (const b of segment.querySelectorAll("button"))
        b.setAttribute("aria-pressed", String(b.dataset.mode === m));
    };
    segment.append(
      h(
        "button",
        {
          type: "button",
          "data-mode": "single",
          title: "One nuclis model answers every decision",
          onclick: () => show("single"),
        },
        "Single model",
      ),
      h(
        "button",
        {
          type: "button",
          "data-mode": "cascade",
          disabled: !!pairsBlocked,
          title:
            pairsBlocked ??
            "A fast model screens each decision; a slow one takes those it is unsure of, cannot read whole, or cannot see",
          onclick: () => show("cascade"),
        },
        "Cascade",
      ),
    );
    show(pairsBlocked ? "single" : mode);
    return row(view, h("div", { class: "picker-nuclis" }, segment, models));
  };

  return h(
    "div",
    { class: "picker", role: "radiogroup", "aria-label": "Autopilot" },
    deciders.map((view) => {
      if (view.id === "cascade" && nuclis) return null;
      if (view.id === "nuclis" && cascade) return nuclisRow(view, cascade);
      return row(view, h("div", { class: "picker-models" }, pills(view)));
    }),
  );
}
