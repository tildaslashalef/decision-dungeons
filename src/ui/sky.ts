// The night sky behind every page: a star field drawn once from a fixed
// seed, so it is the same on every visit, plus a faint milky-way band.
// A few bright stars twinkle (opacity only, cheap to animate); reduced
// motion stops them.

import { seeded } from "../lib/random.ts";
import { h, svg } from "./dom.ts";

const WIDTH = 1600;
const HEIGHT = 900;
/** Layers of stars: count, radius range, opacity range, how many twinkle. */
const LAYERS: [number, number, number, number, number, number][] = [
  [260, 0.35, 0.7, 0.18, 0.45, 0],
  [120, 0.7, 1.1, 0.4, 0.75, 14],
  [22, 1.2, 1.8, 0.75, 1, 10],
];

let field: SVGElement | undefined;

function starField(): SVGElement {
  const rng = seeded(20261002);
  const stars: SVGElement[] = [];
  for (const [count, r0, r1, o0, o1, twinkling] of LAYERS)
    for (let i = 0; i < count; i++) {
      // Denser toward the top; the horizon glow washes out the rest.
      const y = HEIGHT * rng() ** 1.35;
      const star = svg("circle", {
        cx: (WIDTH * rng()).toFixed(1),
        cy: y.toFixed(1),
        r: (r0 + (r1 - r0) * rng()).toFixed(2),
        opacity: (o0 + (o1 - o0) * rng()).toFixed(2),
      });
      if (i < twinkling) {
        star.setAttribute("class", "twinkle");
        star.setAttribute(
          "style",
          `animation-delay:${(-6 * rng()).toFixed(2)}s;animation-duration:${(3 + 4 * rng()).toFixed(2)}s`,
        );
      }
      stars.push(star);
    }
  return svg(
    "svg",
    {
      class: "stars",
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      preserveAspectRatio: "xMidYMid slice",
      "aria-hidden": "true",
      fill: "#ffffff",
    },
    ...stars,
  );
}

/** The sky layer for a `.scene` page. */
export function sky(): HTMLElement {
  field ??= starField();
  return h(
    "div",
    { class: "scene-sky", "aria-hidden": "true" },
    h("div", { class: "milky-way" }),
    field.cloneNode(true) as SVGElement,
  );
}

export function floor(): HTMLElement {
  return h("div", { class: "scene-floor", "aria-hidden": "true" });
}
