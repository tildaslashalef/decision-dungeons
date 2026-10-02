// The autopilot picker: every decider and its models, the unusable ones
// shown disabled with the reason. Used by the start screen and the config page.

import type { Autopilot, DeciderView } from "../contract/api.ts";
import { h } from "./dom.ts";

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

/** The first usable autopilot, preferring `wanted` when it is usable. */
export function defaultAutopilot(
  deciders: DeciderView[],
  wanted?: Autopilot,
): Autopilot | undefined {
  if (wanted && usable(deciders, wanted)) return wanted;
  for (const id of ["rule", "random", "nuclis", "typesafe"]) {
    const view = deciders.find((d) => d.id === id);
    const model = view?.models.find((m) => m.available);
    if (view && model && !deciderBlocked(view))
      return { decider: view.id, model: model.id };
  }
  return undefined;
}

export function autopilotPicker(
  deciders: DeciderView[],
  value: Autopilot | undefined,
  onChange: (choice: Autopilot) => void,
  name = "autopilot",
): HTMLElement {
  return h(
    "div",
    { class: "picker", role: "radiogroup", "aria-label": "Autopilot" },
    deciders.map((view) => {
      const blocked = deciderBlocked(view);
      const version = view.status.version;
      return h(
        "div",
        { class: `picker-row${blocked ? " blocked" : ""}` },
        h(
          "div",
          { class: "picker-name" },
          h("b", {}, view.label),
          h(
            "small",
            {},
            blocked ??
              [
                version,
                view.status.pricing
                  ? `$${view.status.pricing.inputPerMillionUsd} per M input tokens`
                  : view.id === "nuclis"
                    ? "local, free"
                    : null,
              ]
                .filter(Boolean)
                .join(" · "),
          ),
        ),
        h(
          "div",
          { class: "picker-models" },
          view.models.map((model) => {
            const disabled = !!blocked || !model.available;
            const checked =
              value?.decider === view.id && value.model === model.id;
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
          }),
        ),
      );
    }),
  );
}
