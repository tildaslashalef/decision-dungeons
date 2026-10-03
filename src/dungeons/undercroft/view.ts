// Undercroft in the browser: the map drawn from the autopilot's own tiles
// at a larger scale, with the hero's trail, what fog hides dimmed, and the
// last decision's probabilities as arrows around the tile it was made on;
// beside it hit points, keys, and moves against the optimum.

import { h, svg } from "../../ui/dom.ts";
import type { PlayStatus } from "../../ui/store.ts";
import { DIRECTIONS, type Pos, STEP } from "./map.ts";
import { mapPicture } from "./picture.ts";
import {
  inSight,
  known,
  PASS_FACTOR,
  type UndercroftRun,
} from "./undercroft.ts";

/** Pictures already drawn, by run and turn: the view redraws on every store change. */
const drawn = new Map<string, string>();
const pending = new Set<string>();

function picture(run: UndercroftRun, img: HTMLImageElement): void {
  // The trail decides the picture: keys taken, doors opened, what fog has shown.
  const key = `${run.level}:${run.seed}:${run.trail.map((p) => `${p.row},${p.col}`).join(";")}`;
  img.dataset.picture = key;
  const ready = drawn.get(key);
  if (ready) {
    img.src = ready;
    return;
  }
  if (pending.has(key)) return;
  pending.add(key);
  void mapPicture(run.map, run.hero, {
    hidden: (p) => !known(run, p),
    dimmed: (p) => !inSight(run, p),
    trail: run.trail.slice(0, -1),
  }).then((url) => {
    pending.delete(key);
    if (drawn.size > 64) drawn.clear();
    drawn.set(key, url);
    // The element may have been replaced by a newer render; update every one showing this run.
    for (const el of document.querySelectorAll<HTMLImageElement>(
      `img[data-picture="${key}"]`,
    ))
      el.src = url;
  });
}

/** Arrows around the tile a decision was made on, each as long and strong as its probability. */
function arrows(run: UndercroftRun, from: Pos): SVGElement {
  const answer = run.lastAnswer;
  const ps = answer?.probabilities;
  const elements: SVGElement[] = [];
  for (const d of DIRECTIONS) {
    const p = ps ? (ps[d] ?? 0) : answer?.choice === d ? 1 : 0;
    if (p <= 0.01) continue;
    const chosen = answer?.choice === d;
    const cx = from.col + 0.5;
    const cy = from.row + 0.5;
    const len = 0.35 + 0.75 * p;
    const x2 = cx + STEP[d].col * len;
    const y2 = cy + STEP[d].row * len;
    elements.push(
      svg("line", {
        x1: cx + STEP[d].col * 0.28,
        y1: cy + STEP[d].row * 0.28,
        x2,
        y2,
        stroke: chosen ? "#ffd166" : "#ffffff",
        "stroke-width": 0.08 + 0.1 * p,
        "stroke-linecap": "round",
        opacity: 0.35 + 0.65 * p,
      }),
    );
    const tip = svg("text", {
      x: cx + STEP[d].col * (len + 0.32),
      y: cy + STEP[d].row * (len + 0.32) + 0.14,
      "text-anchor": "middle",
      class: "uc-prob",
    });
    tip.textContent = ps ? `${Math.round(p * 100)}%` : "";
    elements.push(tip);
  }
  return svg("g", {}, ...elements);
}

function hearts(hp: number, max: number): HTMLElement {
  return h(
    "span",
    { class: "uc-hearts", "aria-label": `${hp} of ${max} hit points` },
    Array.from({ length: max }, (_, i) =>
      h("i", { class: i < hp ? "uc-heart full" : "uc-heart" }),
    ),
  );
}

export function undercroftView(
  run: UndercroftRun,
  status: PlayStatus,
): HTMLElement {
  const img = h("img", {
    class: "uc-map",
    alt: `The dungeon map, the hero at row ${run.hero.row}, column ${run.hero.col}`,
  });
  picture(run, img);
  const from = run.lastFrom;
  const overlay = svg(
    "svg",
    {
      class: "uc-overlay",
      viewBox: `0 0 ${run.map.cols} ${run.map.rows}`,
      "aria-hidden": "true",
    },
    status !== "deciding" && from ? arrows(run, from) : null,
  );
  const bound = PASS_FACTOR * run.optimal;
  const recent = run.records.slice(-7).reverse();
  return h(
    "div",
    { class: "undercroft" },
    h(
      "div",
      { class: "crossing-head" },
      h(
        "span",
        { class: "eyebrow" },
        `Turn ${run.turns} of at most ${run.limit} · seed ${run.seed}`,
      ),
      run.reached
        ? h("span", { class: "verdict ok" }, "Reached the stairs")
        : run.dead
          ? h("span", { class: "verdict bad" }, "Died")
          : run.turns >= run.limit
            ? h("span", { class: "verdict bad" }, "Out of turns")
            : h(
                "span",
                { class: "verdict pending" },
                status === "deciding"
                  ? "Deciding…"
                  : status === "failed"
                    ? "No answer"
                    : "Exploring",
              ),
    ),
    h(
      "div",
      { class: "uc-grid" },
      h("div", { class: "uc-board" }, img, overlay),
      h(
        "aside",
        { class: "uc-side" },
        h(
          "div",
          { class: "facts uc-facts" },
          h(
            "div",
            { class: "fact" },
            h("span", {}, "Hit points"),
            hearts(run.hp, run.map.hp),
          ),
          h(
            "div",
            { class: "fact" },
            h("span", {}, "Keys"),
            h(
              "b",
              { class: "uc-keys" },
              run.keys.length
                ? run.keys.map((k) => h("i", { class: `uc-key ${k}` }, k))
                : "none",
            ),
          ),
          h(
            "div",
            { class: "fact" },
            h("span", {}, "Moves · optimum"),
            h("b", {}, `${run.steps} · ${run.optimal}`),
            h("small", {}, `pass within ${bound}`),
          ),
          h(
            "div",
            { class: "fact" },
            h("span", {}, "Bumps · gold"),
            h("b", {}, `${run.bumps} · ${run.gold}`),
          ),
        ),
        h(
          "div",
          { class: "uc-meter", title: `${run.steps} moves of ${bound}` },
          h("i", {
            style: `width:${Math.min(100, (run.steps / bound) * 100)}%`,
            class: run.steps > bound ? "uc-meter-fill over" : "uc-meter-fill",
          }),
        ),
        h(
          "ol",
          // Newest first, numbered by turn.
          { class: "uc-log", reversed: true, start: run.records.length },
          recent.map((r) =>
            h("li", { class: r.violation ? "bad" : "" }, r.summary),
          ),
        ),
      ),
    ),
  );
}
