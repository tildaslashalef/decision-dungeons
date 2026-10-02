// The start screen: dungeon, level, autopilot, seed; then play.

import { Play, Settings, Shuffle } from "lucide";
import { dungeonById, dungeons } from "../dungeons/registry.ts";
import { autopilotPicker, usable } from "./autopilot.ts";
import { h, icon } from "./dom.ts";
import type { Store } from "./store.ts";

export interface StartActions {
  play(): void;
  navigate(route: "config"): void;
}

/** A seed for the player to keep or change; simulations never call this. */
const freshSeed = () => Math.floor(Math.random() * 10_000);

export function startScreen(store: Store, actions: StartActions): HTMLElement {
  const { selection, deciders, decidersError } = store.get();
  const dungeon = dungeonById(selection.dungeon);
  const select = (patch: Partial<typeof selection>) =>
    store.set({ selection: { ...store.get().selection, ...patch } });
  const ready = usable(deciders, selection);

  return h(
    "main",
    { class: "page" },
    h(
      "div",
      { class: "card glass start" },
      h(
        "header",
        { class: "card-head" },
        h(
          "div",
          {},
          h("h1", {}, "Decision Dungeons"),
          h("p", {}, "Pick a dungeon and an autopilot, then watch it decide."),
        ),
        h(
          "a",
          {
            href: "/config",
            class: "icon-link",
            "aria-label": "Config",
            title: "Config",
            onclick: (event: Event) => {
              event.preventDefault();
              actions.navigate("config");
            },
          },
          icon(Settings),
        ),
      ),
      h(
        "section",
        {},
        h("h2", {}, "Dungeon"),
        h(
          "div",
          { class: "choices" },
          Object.values(dungeons).map((d) =>
            h(
              "label",
              {
                class: `choice${d.id === selection.dungeon ? " checked" : ""}`,
              },
              h("input", {
                type: "radio",
                name: "dungeon",
                value: d.id,
                checked: d.id === selection.dungeon,
                onchange: () =>
                  select({ dungeon: d.id, level: d.levels[0]?.id ?? "" }),
              }),
              h("b", {}, d.title),
              h("span", {}, d.description),
            ),
          ),
        ),
      ),
      dungeon
        ? h(
            "section",
            {},
            h("h2", {}, "Level"),
            h(
              "div",
              { class: "choices levels" },
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
          )
        : null,
      h(
        "section",
        {},
        h("h2", {}, "Autopilot"),
        deciders
          ? autopilotPicker(deciders, selection, (choice) => select(choice))
          : h(
              "p",
              { class: decidersError ? "error-text" : "" },
              decidersError ?? "Asking the server which deciders are ready…",
            ),
      ),
      h(
        "footer",
        { class: "card-foot" },
        h(
          "label",
          { class: "seed" },
          h("span", {}, "Seed"),
          h("input", {
            type: "number",
            min: 0,
            step: 1,
            value: selection.seed,
            onchange: (event: Event) => {
              const value = Number((event.target as HTMLInputElement).value);
              if (Number.isSafeInteger(value) && value >= 0)
                select({ seed: value });
            },
          }),
          h(
            "button",
            {
              type: "button",
              "aria-label": "New seed",
              title: "New seed",
              onclick: () => select({ seed: freshSeed() }),
            },
            icon(Shuffle),
          ),
        ),
        h(
          "button",
          {
            type: "button",
            class: "primary",
            disabled: !ready,
            onclick: actions.play,
          },
          icon(Play),
          "Play",
        ),
      ),
    ),
  );
}
