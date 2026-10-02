// A dungeon's lobby: its art and story on one side; level, autopilot,
// evaluation mode (when the dungeon has safety nets), the case set (when
// it plays from one), and seed on the other; then start the run.

import type { Autopilot, DeciderView } from "../contract/api.ts";
import type { Level, LevelTag } from "../dungeons/dungeon.ts";
import { dungeonById } from "../dungeons/registry.ts";
import { autopilotPicker, defaultAutopilot, usable } from "./autopilot.ts";
import { h } from "./dom.ts";
import { artFor } from "./dungeon-art.ts";
import { svgIcon } from "./icons.ts";
import { floor, sky } from "./sky.ts";
import type { Store } from "./store.ts";
import { backLink, topbar } from "./topbar.ts";

/** How the lobby names each level tag: the models it is meant to test. */
const LEVEL_TAGS: Record<LevelTag, { label: string; detail: string }> = {
  "many-questions": {
    label: "Several questions · for clef-flash",
    detail:
      "Every question about a case goes in one request: clef-flash answers them all in one pass, Laya runs a pass per question.",
  },
  "long-input": {
    label: "Long input · for clef-flash",
    detail:
      "Past Laya's budget (512 or 1,024 tokens), so it reads a cut state; clef-flash reads up to 16,384 tokens.",
  },
  images: {
    label: "Pictures · for clef-flash",
    detail:
      "The request carries a picture: only a model that reads images, such as clef-flash, can see it.",
  },
};

/**
 * The deciders as `level` can use them: a level with pictures needs a
 * model that reads images, or the rule when the facts are also given as
 * text.
 */
export function forLevel(
  deciders: DeciderView[] | undefined,
  level: Level | undefined,
): DeciderView[] | undefined {
  const images = level?.images;
  if (!deciders || !images) return deciders;
  return deciders.map((view) => ({
    ...view,
    models: view.models.map((m) => {
      const sees =
        m.images === true || (view.id === "rule" && images === "with-text");
      if (sees || !m.available) return m;
      return {
        ...m,
        available: false,
        reason:
          view.id === "rule"
            ? "reads the data; this level shows only the picture"
            : "cannot see pictures",
      };
    }),
  }));
}

/** For a level the chosen autopilot cannot play: a model that sees pictures, else the usual default. */
function fallback(deciders: DeciderView[]): Autopilot | undefined {
  for (const view of deciders) {
    if (view.id === "random") continue;
    const model = view.models.find((m) => m.available && m.images);
    if (model) return { decider: view.id, model: model.id };
  }
  return defaultAutopilot(deciders);
}

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
  const levelOf = (id: string) => dungeon.levels.find((l) => l.id === id);
  const level = levelOf(selection.level);
  const pilotsHere = forLevel(deciders, level);
  const chooseLevel = (id: string) => {
    const here = forLevel(deciders, levelOf(id));
    const keep = !here || usable(here, selection);
    const next = keep ? undefined : fallback(here);
    select({ level: id, ...(next ?? {}) });
  };
  const ready =
    usable(pilotsHere, selection) &&
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
            onchange: () => chooseLevel(level.id),
          }),
          h("b", {}, level.title),
          h("span", {}, level.description),
          level.tags?.length
            ? h(
                "ul",
                { class: "level-tags" },
                level.tags.map((tag) =>
                  h(
                    "li",
                    { class: "level-tag", title: LEVEL_TAGS[tag].detail },
                    LEVEL_TAGS[tag].label,
                  ),
                ),
              )
            : null,
        ),
      ),
    ),
  );

  const pilots = h(
    "section",
    { class: "lobby-step" },
    h("h2", {}, "Choose an autopilot"),
    pilotsHere
      ? autopilotPicker(pilotsHere, selection, (choice) => select(choice))
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
                  ? `${chosenSet.levels[level?.casesOf ?? selection.level] ?? 0} ${level?.casesOf ?? selection.level} cases, ${chosenSet.generator}, hash ${chosenSet.hash}. A run asks 20, picked by the seed. bun run seed writes more sets.`
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
