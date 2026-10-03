// Which case a card view shows, and the strip of cases along its bottom:
// the one being asked or just answered while a run plays, any answered one
// a person picks once it stops deciding.

import { h } from "./dom.ts";
import type { PlayStatus } from "./store.ts";
import type { Browse } from "./views.ts";

/** The case to show, and whether it has been answered. */
export function shownCase(
  answered: number,
  total: number,
  status: PlayStatus,
  browse: Browse,
): { index: number; answered: boolean } {
  if (browse.focus !== undefined && browse.focus < answered)
    return { index: browse.focus, answered: true };
  const done = status !== "deciding" && answered > 0;
  return {
    index: done ? answered - 1 : Math.min(answered, total - 1),
    answered: done,
  };
}

/** One segment per case, coloured by `state`; each a button while cases can be picked. */
export function caseStrip(
  total: number,
  shown: number,
  state: (i: number) => "ok" | "bad" | "",
  title: (i: number) => string,
  browse: Browse,
  label = "Cases",
): HTMLElement {
  return h(
    "ol",
    {
      class: `case-strip${browse.select ? " browsing" : ""}`,
      "aria-label": label,
    },
    Array.from({ length: total }, (_, i) => {
      const s = state(i);
      const cls = [
        s || (i === shown ? "now" : ""),
        i === shown && s ? "shown" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const select = browse.select;
      return h(
        "li",
        { class: cls, title: title(i) },
        select && s
          ? h("button", {
              type: "button",
              class: "strip-pick",
              "aria-label": `Show case ${i + 1}: ${title(i)}`,
              onclick: () => select(i),
            })
          : null,
      );
    }),
  );
}
