// How each dungeon presents itself on the gate and in its lobby: an accent,
// a one-line tagline, and an illustration drawn in SVG. Keyed by dungeon
// id; a dungeon without an entry gets the generic door, so a new dungeon
// appears on the gate the moment it is registered.

import { svg } from "./dom.ts";
import type { IconName } from "./icons.ts";

export interface DungeonArt {
  accent: string;
  /** Shown on the gate under the dungeon's title. */
  tagline: string;
  /** The dungeon's mark on badges and in the config page. */
  emblem: IconName;
  /** Short facts about the dungeon's worlds or cases, shown as badges. */
  facts: { icon: IconName; text: string }[];
  /** Draws the illustration; `key` keeps gradient ids unique per drawing. */
  draw(key: string): SVGElement;
}

/** The illustrations share one frame: 300 wide, 400 tall, horizon near 150. */
const VIEW = "0 0 300 400";

function frame(label: string, ...children: (SVGElement | null)[]): SVGElement {
  return svg(
    "svg",
    {
      viewBox: VIEW,
      preserveAspectRatio: "xMidYMid slice",
      role: "img",
      "aria-label": label,
      class: "art",
    },
    ...children,
  );
}

function gradient(
  id: string,
  stops: [number, string][],
  vertical = true,
): SVGElement {
  return svg(
    "linearGradient",
    { id, x1: 0, y1: 0, x2: vertical ? 0 : 1, y2: vertical ? 1 : 0 },
    ...stops.map(([offset, color]) =>
      svg("stop", { offset, "stop-color": color }),
    ),
  );
}

const rect = (
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  extra: Record<string, string | number> = {},
) => svg("rect", { x, y, width: w, height: h, fill, ...extra });

const path = (d: string, attrs: Record<string, string | number>) =>
  svg("path", { d, ...attrs });

/** A city street running to the horizon, the car on it, its chosen path in blue. */
function drawDriving(key: string): SVGElement {
  const sky = `${key}-sky`;
  const road = `${key}-road`;
  const glow = `${key}-glow`;
  const towers: [number, number, number, string][] = [
    [0, 40, 60, "#9fb3c2"],
    [44, 72, 36, "#b8c6d1"],
    [70, 104, 26, "#c9d3db"],
    [204, 100, 28, "#c9d3db"],
    [226, 66, 40, "#b3c3cf"],
    [256, 30, 44, "#94a9ba"],
  ];
  return frame(
    "A city street seen from behind a car, its planned path drawn in blue",
    svg(
      "defs",
      {},
      gradient(sky, [
        [0, "#dfe8f1"],
        [1, "#f6f7f9"],
      ]),
      gradient(road, [
        [0, "#a7adb5"],
        [1, "#5d636c"],
      ]),
      gradient(glow, [
        [0, "#3e6ae100"],
        [1, "#3e6ae1"],
      ]),
    ),
    rect(0, 0, 300, 400, `url(#${sky})`),
    ...towers.map(([x, top, w, fill]) => rect(x, top, w, 150 - top + 2, fill)),
    // Window rows on the near towers.
    ...[0, 256].flatMap((x) =>
      Array.from({ length: 9 }, (_, i) =>
        rect(x + 6, (x === 0 ? 50 : 40) + i * 11, 32, 3, "#ffffff66"),
      ),
    ),
    rect(0, 148, 300, 252, "#cfd6cc"),
    // Sidewalks, then the road narrowing to the horizon.
    path("M150 148 L-60 400 L360 400 Z", { fill: "#e4e2dc" }),
    path("M150 148 L-20 400 L320 400 Z", { fill: `url(#${road})` }),
    path("M150 150 L136 400 L164 400 Z", { fill: "none" }),
    ...[0, 1, 2, 3, 4].map((i) => {
      const y = 170 + i * i * 9 + i * 18;
      const h = 6 + i * 6;
      const w = 1.4 + i * 1.3;
      return rect(150 - w / 2, y, w, h, "#f2f2ee");
    }),
    path("M150 148 L4 400", { stroke: "#ffffffb0", "stroke-width": 2 }),
    path("M150 148 L296 400", { stroke: "#ffffffb0", "stroke-width": 2 }),
    // The chosen path: a blue ribbon bending gently ahead of the car.
    path("M150 318 C 150 270, 168 236, 160 196", {
      stroke: `url(#${glow})`,
      "stroke-width": 9,
      "stroke-linecap": "round",
      fill: "none",
    }),
    // The car, from behind.
    rect(122, 312, 56, 40, "#f4f4f2", { rx: 12 }),
    rect(129, 318, 42, 14, "#2b3038", { rx: 5 }),
    rect(124, 338, 10, 5, "#e82127", { rx: 2 }),
    rect(166, 338, 10, 5, "#e82127", { rx: 2 }),
    rect(118, 346, 12, 10, "#1d2026", { rx: 3 }),
    rect(170, 346, 12, 10, "#1d2026", { rx: 3 }),
    svg("ellipse", { cx: 150, cy: 360, rx: 36, ry: 5, fill: "#00000026" }),
  );
}

/** A stop line under a red signal, the car close to the line. */
function drawCrossing(key: string): SVGElement {
  const sky = `${key}-sky`;
  const halo = `${key}-halo`;
  return frame(
    "A car approaching a stop line under a red traffic light",
    svg(
      "defs",
      {},
      gradient(sky, [
        [0, "#f3e6e3"],
        [1, "#f7f5f2"],
      ]),
      svg(
        "radialGradient",
        { id: halo },
        svg("stop", {
          offset: 0,
          "stop-color": "#e82127",
          "stop-opacity": 0.55,
        }),
        svg("stop", { offset: 1, "stop-color": "#e82127", "stop-opacity": 0 }),
      ),
    ),
    rect(0, 0, 300, 400, `url(#${sky})`),
    rect(0, 196, 300, 204, "#d8dcd2"),
    path("M110 196 L-40 400 L340 400 L190 196 Z", { fill: "#7a8089" }),
    // The stop line, wide across the lane.
    path("M74 262 L226 262 L236 276 L64 276 Z", { fill: "#f6f6f2" }),
    // The signal: a pole and a lit red lamp.
    rect(224, 40, 8, 170, "#2a2e35"),
    rect(208, 34, 40, 104, "#171a20", { rx: 10 }),
    svg("circle", { cx: 228, cy: 58, r: 46, fill: `url(#${halo})` }),
    svg("circle", { cx: 228, cy: 58, r: 12, fill: "#e82127" }),
    svg("circle", { cx: 228, cy: 86, r: 12, fill: "#3a3f47" }),
    svg("circle", { cx: 228, cy: 114, r: 12, fill: "#3a3f47" }),
    // The car, nose a metre short of the line.
    rect(104, 290, 92, 62, "#f4f4f2", { rx: 16 }),
    rect(114, 298, 72, 22, "#2b3038", { rx: 7 }),
    rect(108, 326, 14, 7, "#e82127", { rx: 3 }),
    rect(178, 326, 14, 7, "#e82127", { rx: 3 }),
    svg("ellipse", { cx: 150, cy: 360, rx: 54, ry: 7, fill: "#00000026" }),
  );
}

/** Any dungeon without its own illustration: a doorway into the dark. */
function drawDoor(key: string): SVGElement {
  const depth = `${key}-depth`;
  return frame(
    "A doorway",
    svg(
      "defs",
      {},
      gradient(depth, [
        [0, "#2f343c"],
        [1, "#171a20"],
      ]),
    ),
    rect(0, 0, 300, 400, "#e9ebee"),
    path("M70 400 L70 170 A80 80 0 0 1 230 170 L230 400 Z", {
      fill: `url(#${depth})`,
    }),
    ...Array.from({ length: 6 }, (_, i) =>
      rect(
        70 - i * 6,
        400 - (i + 1) * 14,
        160 + i * 12,
        14,
        i % 2 ? "#d9dce1" : "#cfd3d9",
      ),
    ),
  );
}

const ART: Record<string, DungeonArt> = {
  driving: {
    accent: "#3e6ae1",
    tagline: "Drive a car through a town, a city, and Interstate 08.",
    emblem: "cityCar",
    facts: [
      { icon: "horizonRoad", text: "Town, city, interstate" },
      { icon: "trafficCone", text: "Live traffic" },
      { icon: "trafficLights", text: "Stop-line check" },
    ],
    draw: drawDriving,
  },
  crossing: {
    accent: "#e82127",
    tagline: "Drive or stop at a red light, one case at a time.",
    emblem: "trafficLights",
    facts: [
      { icon: "dice", text: "12 seeded cases" },
      { icon: "ruleBook", text: "Known answers" },
      { icon: "crossroad", text: "Signal and distance" },
    ],
    draw: drawCrossing,
  },
};

const FALLBACK: DungeonArt = {
  accent: "#171a20",
  tagline: "",
  emblem: "dungeonGate",
  facts: [],
  draw: drawDoor,
};

/** Gate order: dungeons with art first, in the order above, then the rest. */
export const ART_ORDER = Object.keys(ART);

export function artFor(id: string): DungeonArt {
  return ART[id] ?? FALLBACK;
}
