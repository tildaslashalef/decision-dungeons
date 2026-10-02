// The home page, a world-select screen: every dungeon is a stone gateway
// under a night sky. Arrow keys or hover pick a gate, Enter or a click goes
// in; levels, autopilot, and seed are chosen in the dungeon's lobby.

import type { DeciderView } from "../contract/api.ts";
import type { AnyDungeon } from "../dungeons/dungeon.ts";
import { dungeons } from "../dungeons/registry.ts";
import { deciderBlocked, deciderIcon } from "./autopilot.ts";
import { h, replace } from "./dom.ts";
import { ART_ORDER, artFor } from "./dungeon-art.ts";
import { svgIcon } from "./icons.ts";
import { floor, sky } from "./sky.ts";
import type { Store } from "./store.ts";
import { link, topbar } from "./topbar.ts";

export interface GateActions {
  enter(dungeon: string): void;
  home(): void;
  config(): void;
}

/** Dungeons with their own art first, in the art registry's order. */
export function orderedDungeons(): AnyDungeon[] {
  const rank = (id: string) => {
    const i = ART_ORDER.indexOf(id);
    return i < 0 ? ART_ORDER.length : i;
  };
  return Object.values(dungeons).sort((a, b) => rank(a.id) - rank(b.id));
}

/** The gate last selected, kept across visits to the home page. */
let selectedId: string | undefined;

const levelCount = (dungeon: AnyDungeon) =>
  `${dungeon.levels.length} level${dungeon.levels.length === 1 ? "" : "s"}`;

function statusLights(
  deciders: DeciderView[] | undefined,
  error: string | undefined,
): HTMLElement {
  if (!deciders)
    return h(
      "p",
      { class: `lights-note${error ? " error-text" : ""}` },
      error ?? "Checking autopilots…",
    );
  return h(
    "ul",
    { class: "lights", "aria-label": "Autopilots" },
    deciders.map((d) => {
      const blocked = deciderBlocked(d);
      return h(
        "li",
        {
          class: blocked ? "off" : "on",
          title: blocked ? `${d.label}: ${blocked}` : `${d.label} is ready`,
        },
        deciderIcon(d.id),
        d.label,
        h("i", { "aria-hidden": "true" }),
        h(
          "span",
          { class: "visually-hidden" },
          blocked ? " (not ready)" : " (ready)",
        ),
      );
    }),
  );
}

function gateway(
  dungeon: AnyDungeon,
  index: number,
  selected: boolean,
  actions: GateActions,
): HTMLAnchorElement {
  const art = artFor(dungeon.id);
  return link(
    `/d/${dungeon.id}`,
    () => actions.enter(dungeon.id),
    {
      class: `portal${selected ? " selected" : ""}`,
      style: `--dungeon:${art.accent};--i:${index}`,
      "aria-label": `${dungeon.title}, ${levelCount(dungeon)}: ${art.tagline || dungeon.description}`,
    },
    h(
      "span",
      { class: "portal-arch" },
      h("span", { class: "portal-keystone" }),
      h("span", { class: "portal-window" }, art.draw(`gate-${dungeon.id}`)),
    ),
    h(
      "span",
      { class: "portal-plate" },
      svgIcon(art.emblem, "plate-emblem"),
      h("span", { class: "plate-name" }, dungeon.title),
      h(
        "span",
        { class: "badge" },
        svgIcon("stack"),
        String(dungeon.levels.length),
      ),
    ),
    art.facts.length
      ? h(
          "span",
          { class: "portal-tags" },
          art.facts
            .slice(0, 2)
            .map((fact) =>
              h("span", { class: "tag" }, svgIcon(fact.icon), fact.text),
            ),
        )
      : null,
  );
}

export function gatePage(store: Store, actions: GateActions): HTMLElement {
  const { deciders, decidersError } = store.get();
  const all = orderedDungeons();
  if (!all.some((d) => d.id === selectedId)) selectedId = all[0]?.id;

  const caption = h("div", { class: "gate-caption", "aria-live": "polite" });
  const showCaption = (dungeon: AnyDungeon) => {
    const art = artFor(dungeon.id);
    caption.style.setProperty("--dungeon", art.accent);
    replace(
      caption,
      svgIcon(art.emblem, "caption-emblem"),
      h(
        "div",
        {},
        h("h2", {}, dungeon.title),
        h("p", {}, art.tagline || dungeon.description),
      ),
      h(
        "span",
        { class: "caption-enter" },
        svgIcon("doorOpen"),
        `Enter · ${levelCount(dungeon)}`,
      ),
    );
  };

  const cards: HTMLAnchorElement[] = [];
  const select = (index: number, focus: boolean) => {
    const dungeon = all[index];
    const card = cards[index];
    if (!dungeon || !card) return;
    selectedId = dungeon.id;
    for (const c of cards) c.classList.toggle("selected", c === card);
    showCaption(dungeon);
    if (focus) card.focus();
    card.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  all.forEach((dungeon, index) => {
    const card = gateway(dungeon, index, dungeon.id === selectedId, actions);
    card.addEventListener("mouseenter", () => select(index, false));
    card.addEventListener("focus", () => select(index, false));
    cards.push(card);
  });

  const row = h(
    "nav",
    {
      class: "portals",
      "aria-label": "Dungeons",
      onkeydown: (event: Event) => {
        const key = (event as KeyboardEvent).key;
        const current = all.findIndex((d) => d.id === selectedId);
        const next =
          key === "ArrowRight"
            ? Math.min(all.length - 1, current + 1)
            : key === "ArrowLeft"
              ? Math.max(0, current - 1)
              : key === "Home"
                ? 0
                : key === "End"
                  ? all.length - 1
                  : -1;
        if (next < 0) return;
        event.preventDefault();
        select(next, true);
      },
    },
    cards,
  );
  const selected = all.find((d) => d.id === selectedId);
  if (selected) showCaption(selected);

  return h(
    "main",
    { class: "gate scene" },
    sky(),
    floor(),
    topbar(actions.home, actions.config),
    h(
      "header",
      { class: "gate-head" },
      h("h1", {}, "Choose a dungeon"),
      h(
        "p",
        {},
        "Send a decision model into a world built to test it, then watch every choice it makes.",
      ),
    ),
    row,
    caption,
    h(
      "footer",
      { class: "gate-foot" },
      statusLights(deciders, decidersError),
      h(
        "p",
        { class: "keys" },
        h("kbd", { "aria-label": "Left arrow" }, svgIcon("arrowLeft")),
        h("kbd", { "aria-label": "Right arrow" }, svgIcon("arrowRight")),
        h("span", {}, "choose"),
        h("kbd", { "aria-label": "Enter" }, svgIcon("enterKey")),
        h("span", {}, "enter"),
      ),
    ),
  );
}

/** Focuses the selected gate so the arrow keys work at once. */
export function focusGate(root: HTMLElement): void {
  root
    .querySelector<HTMLElement>(".portal.selected")
    ?.focus({ preventScroll: true });
}
