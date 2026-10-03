// The run's quick switches, in every play view's top bar: the autopilot,
// the level, and (for a dungeon that plays case sets) the case set. A
// change starts the run again with the new choice, as the lobby would.

import { dungeonById } from "../dungeons/registry.ts";
import { autopilotOptions } from "./autopilot.ts";
import { h } from "./dom.ts";
import { fallback, forLevel } from "./lobby.ts";
import type { Selection, Store } from "./store.ts";

export type SwitchFn = (change: Partial<Selection>) => void;

/** Selects for the autopilot, the level, and the case set; `tone` matches the bar they sit in. */
export function runSwitcher(
  store: Store,
  selection: Selection,
  onSwitch: SwitchFn,
  show: { tone?: "light" | "dark"; level?: boolean } = {},
): HTMLElement {
  const { tone = "light", level: withLevel = true } = show;
  const { deciders, caseSets } = store.get();
  const dungeon = dungeonById(selection.dungeon);
  const levelOf = (id: string) => dungeon?.levels.find((l) => l.id === id);
  const here = forLevel(deciders, levelOf(selection.level));
  const current = `${selection.decider}/${selection.model}`;

  const options = here ? autopilotOptions(here) : [];
  const groups = new Map<string, typeof options>();
  for (const o of options)
    groups.set(o.decider, [...(groups.get(o.decider) ?? []), o]);
  const autopilot = h(
    "select",
    {
      class: "switch-select",
      name: "switch-autopilot",
      "aria-label": "Autopilot",
      title: "Autopilot",
      onchange: (event: Event) => {
        const [decider = "", ...model] = (
          event.target as HTMLSelectElement
        ).value.split("/");
        onSwitch({ decider, model: model.join("/") });
      },
    },
    options.some((o) => `${o.decider}/${o.model}` === current)
      ? null
      : h(
          "option",
          { value: current, selected: true },
          `${selection.decider} · ${selection.model}`,
        ),
    [...groups].map(([id, models]) =>
      h(
        "optgroup",
        { label: here?.find((d) => d.id === id)?.label ?? id },
        models.map((o) =>
          h(
            "option",
            {
              value: `${o.decider}/${o.model}`,
              disabled: !!o.blocked,
              selected: `${o.decider}/${o.model}` === current,
              title: o.blocked ?? "",
            },
            o.label,
          ),
        ),
      ),
    ),
  );

  const level = h(
    "select",
    {
      class: "switch-select",
      name: "switch-level",
      "aria-label": "Level",
      title: "Level",
      onchange: (event: Event) => {
        const id = (event.target as HTMLSelectElement).value;
        // A level the chosen autopilot cannot play (a picture only) takes the lobby's fallback.
        const next = forLevel(deciders, levelOf(id));
        const usable = next
          ?.find((d) => d.id === selection.decider)
          ?.models.some((m) => m.id === selection.model && m.available);
        onSwitch({
          level: id,
          ...(next && usable === false ? (fallback(next) ?? {}) : {}),
        });
      },
    },
    (dungeon?.levels ?? []).map((l) =>
      h("option", { value: l.id, selected: l.id === selection.level }, l.title),
    ),
  );

  const sets = dungeon?.caseSets ? caseSets?.[dungeon.id] : undefined;
  const set = sets?.length
    ? h(
        "select",
        {
          class: "switch-select",
          name: "switch-set",
          "aria-label": "Case set",
          title: "Case set",
          onchange: (event: Event) =>
            onSwitch({ caseSet: (event.target as HTMLSelectElement).value }),
        },
        sets.map((s) =>
          h(
            "option",
            { value: s.name, selected: s.name === selection.caseSet },
            `set ${s.name}`,
          ),
        ),
      )
    : null;

  return h(
    "div",
    { class: `switcher switcher-${tone}` },
    withLevel ? level : null,
    autopilot,
    set,
  );
}
