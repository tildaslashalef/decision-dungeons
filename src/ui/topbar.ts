// The floating glass bar every page shares: the brand, an optional middle
// (where you are), and the config link.

import { type Child, h } from "./dom.ts";
import { svgIcon } from "./icons.ts";

/** The app mark (public/icons/mark.svg): a stone gateway with a forked path. */
export function brandMark(): HTMLImageElement {
  return h("img", {
    class: "brand-mark",
    src: "/icons/mark.svg",
    alt: "",
    width: 24,
    height: 24,
  });
}

export function link(
  href: string,
  go: () => void,
  props: Record<string, string>,
  ...children: Child[]
): HTMLAnchorElement {
  return h(
    "a",
    {
      ...props,
      href,
      onclick: (event: Event) => {
        const e = event as MouseEvent;
        // Let modified clicks open a new tab.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        event.preventDefault();
        go();
      },
    },
    ...children,
  );
}

/** The "All dungeons" link back to the gate. */
export function backLink(goHome: () => void): HTMLAnchorElement {
  return link(
    "/",
    goHome,
    { class: "back-link" },
    svgIcon("arrowLeft"),
    h("span", {}, "All dungeons"),
  );
}

export function topbar(
  goHome: () => void,
  goConfig: (() => void) | null,
  ...middle: Child[]
): HTMLElement {
  return h(
    "header",
    { class: "topbar glass" },
    link(
      "/",
      goHome,
      { class: "brand", "aria-label": "Decision Dungeons, home" },
      brandMark(),
      h("b", {}, "Decision Dungeons"),
    ),
    middle.length ? h("div", { class: "topbar-middle" }, ...middle) : null,
    goConfig
      ? link(
          "/config",
          goConfig,
          { class: "icon-link", "aria-label": "Settings", title: "Settings" },
          svgIcon("gear"),
        )
      : null,
  );
}
