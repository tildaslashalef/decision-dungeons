// A dungeon's lobby: its art and story on one side; level, autopilot,
// evaluation mode (when the dungeon has safety nets), the case set (when
// it plays from one), and seed on the other; then start the run.

import { dungeonById } from "../dungeons/registry.ts";
import { autopilotPicker, usable } from "./autopilot.ts";
import { h } from "./dom.ts";
import { artFor } from "./dungeon-art.ts";
import { svgIcon } from "./icons.ts";
import { floor, sky } from "./sky.ts";
import type { Store } from "./store.ts";
import { backLink, topbar } from "./topbar.ts";

export interface LobbyActions {
  play(): void;
  home(): void;
  config(): void;
}

/** A seed for the player to keep or change; simulations never call this. */
const freshSeed = () => Math.floor(Math.random() * 10_000);

export function lobbyPage(store: Store, actions: LobbyActions): HTMLElement {
  const { selection, deciders, decidersError, caseSets, caseSetsError } =
    store.get();
  const dungeon = dungeonById(selection.dungeon);
  if (!dungeon) return h("main", { class: "lobby" });
  const art = artFor(dungeon.id);
  const select = (patch: Partial<typeof selection>) =>
    store.set({ selection: { ...store.get().selection, ...patch } });
  const sets = caseSets?.[dungeon.id];
  const ready =
    usable(deciders, selection) &&
    (!dungeon.caseSets || !!sets?.some((s) => s.name === selection.caseSet));
  const autopilot = deciders?.find((d) => d.id === selection.decider);

  const hero = h(
    "section",
    { class: "lobby-hero" },
    h(
      "div",
      { class: "portal-arch lobby-arch" },
      h("span", { class: "portal-keystone" }),
      h("span", { class: "portal-window" }, art.draw(`lobby-${dungeon.id}`)),
    ),
    h(
      "div",
      { class: "lobby-story" },
      h("h1", {}, dungeon.title),
      h("p", {}, dungeon.description),
      art.facts.length
        ? h(
            "ul",
            { class: "lobby-facts" },
            art.facts.map((fact) =>
              h("li", { class: "tag" }, svgIcon(fact.icon), fact.text),
            ),
          )
        : null,
    ),
  );

  const levels = h(
    "section",
    { class: "lobby-step" },
    h("h2", {}, "Choose a level"),
    h(
      "div",
      { class: "level-grid", role: "radiogroup", "aria-label": "Level" },
      dungeon.levels.map((level) =>
        h(
          "label",
          {
            class: `choice${level.id === selection.level ? " checked" : ""}`,
          },
          h("input", {
            type: "radio",
            name: "level",
            value: level.id,
            checked: level.id === selection.level,
            onchange: () => select({ level: level.id }),
          }),
          h("b", {}, level.title),
          h("span", {}, level.description),
        ),
      ),
    ),
  );

  const pilots = h(
    "section",
    { class: "lobby-step" },
    h("h2", {}, "Choose an autopilot"),
    deciders
      ? autopilotPicker(deciders, selection, (choice) => select(choice))
      : h(
          "p",
          { class: decidersError ? "error-text" : "" },
          decidersError ?? "Checking which autopilots are ready…",
        ),
  );

  const evaluation = dungeon.evaluation
    ? h(
        "section",
        { class: "lobby-step" },
        h("h2", {}, "Safety nets"),
        h(
          "label",
          { class: "switch-row" },
          h("input", {
            type: "checkbox",
            role: "switch",
            name: "evaluation",
            checked: selection.evaluation,
            onchange: (event: Event) =>
              select({
                evaluation: (event.target as HTMLInputElement).checked,
              }),
          }),
          h("i", { class: "switch", "aria-hidden": "true" }),
          h(
            "span",
            {},
            h("b", { class: "switch-title" }, "Evaluation mode"),
            h("span", { class: "switch-hint" }, dungeon.evaluation),
          ),
        ),
      )
    : null;

  const chosenSet = sets?.find((s) => s.name === selection.caseSet);
  const cases = dungeon.caseSets
    ? h(
        "section",
        { class: "lobby-step" },
        h("h2", {}, "Cases"),
        sets
          ? h(
              "label",
              { class: "case-set" },
              h(
                "select",
                {
                  class: "select",
                  name: "case-set",
                  onchange: (event: Event) =>
                    select({
                      caseSet: (event.target as HTMLSelectElement).value,
                    }),
                },
                sets.map((s) =>
                  h(
                    "option",
                    { value: s.name, selected: s.name === selection.caseSet },
                    `${s.name} · ${s.count} cases · seed ${s.seed}`,
                  ),
                ),
              ),
              h(
                "span",
                { class: "switch-hint" },
                chosenSet
                  ? `${chosenSet.levels[selection.level] ?? 0} ${selection.level} cases, ${chosenSet.generator}, hash ${chosenSet.hash}. A run asks 20, picked by the seed. bun run seed writes more sets.`
                  : "Choose a case set.",
              ),
            )
          : h(
              "p",
              { class: caseSetsError ? "error-text" : "" },
              caseSetsError ?? "Reading the case sets…",
            ),
      )
    : null;

  const start = h(
    "footer",
    { class: "lobby-start" },
    h(
      "label",
      { class: "seed" },
      h("span", { class: "field-label" }, "Seed"),
      h(
        "span",
        { class: "input-group" },
        svgIcon("hash", "input-icon"),
        h("input", {
          class: "input",
          type: "number",
          inputmode: "numeric",
          min: 0,
          step: 1,
          value: selection.seed,
          onchange: (event: Event) => {
            const value = Number((event.target as HTMLInputElement).value);
            if (Number.isSafeInteger(value) && value >= 0)
              select({ seed: value });
          },
        }),
      ),
      h(
        "button",
        {
          type: "button",
          class: "btn btn-icon",
          "aria-label": "New seed",
          title: "New seed",
          onclick: () => select({ seed: freshSeed() }),
        },
        svgIcon("shuffle"),
      ),
    ),
    h(
      "div",
      { class: "start-summary" },
      h(
        "b",
        {},
        dungeon.levels.find((l) => l.id === selection.level)?.title ?? "",
      ),
      h(
        "span",
        {},
        autopilot
          ? `${autopilot.label}, ${selection.model}${selection.evaluation && dungeon.evaluation ? ", evaluation mode" : ""}`
          : "No autopilot chosen",
      ),
    ),
    h(
      "button",
      {
        type: "button",
        class: "btn btn-primary start-button",
        disabled: !ready,
        onclick: actions.play,
      },
      svgIcon("play"),
      "Start run",
    ),
  );

  return h(
    "main",
    { class: "lobby scene", style: `--dungeon:${art.accent}` },
    sky(),
    floor(),
    topbar(actions.home, actions.config, backLink(actions.home)),
    hero,
    h(
      "div",
      { class: "lobby-panel glass" },
      h("div", { class: "lobby-scroll" }, levels, pilots, evaluation, cases),
      start,
    ),
  );
}
