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

/** An envelope on a hook: mail that may be bait. */
function drawInbox(key: string): SVGElement {
  const sky = `${key}-sky`;
  return frame(
    "An envelope hanging from a fishing hook",
    svg(
      "defs",
      {},
      gradient(sky, [
        [0, "#dcefeb"],
        [1, "#f5f7f6"],
      ]),
    ),
    rect(0, 0, 300, 400, `url(#${sky})`),
    // The line and the hook.
    path("M150 0 L150 150", { stroke: "#3b4048", "stroke-width": 2 }),
    path("M150 150 C150 176, 176 176, 176 156", {
      stroke: "#3b4048",
      "stroke-width": 4,
      fill: "none",
      "stroke-linecap": "round",
    }),
    // The envelope, tilted on the hook.
    svg(
      "g",
      { transform: "rotate(-8 150 240)" },
      rect(76, 168, 148, 104, "#fdfdfb", { rx: 8, stroke: "#c9ced4" }),
      path("M76 176 L150 230 L224 176", {
        stroke: "#9aa3ad",
        "stroke-width": 3,
        fill: "none",
      }),
      rect(186, 180, 26, 32, "#0e8a7e", { rx: 3 }),
    ),
    // Other mail below, waiting.
    rect(48, 320, 96, 56, "#ffffff", { rx: 6, stroke: "#d5d9de" }),
    rect(156, 330, 96, 56, "#ffffff", { rx: 6, stroke: "#d5d9de" }),
    path("M48 324 L96 352 L144 324", {
      stroke: "#c4cad1",
      "stroke-width": 2,
      fill: "none",
    }),
    path("M156 334 L204 362 L252 334", {
      stroke: "#c4cad1",
      "stroke-width": 2,
      fill: "none",
    }),
  );
}

/** A long printed receipt, a lens over its total. */
function drawReceipts(key: string): SVGElement {
  const sky = `${key}-sky`;
  const line = (y: number, w: number, right = true) => [
    rect(96, y, w, 6, "#c9cdd3", { rx: 3 }),
    right ? rect(184, y, 26, 6, "#b6bbc2", { rx: 3 }) : null,
  ];
  return frame(
    "A printed receipt under a magnifying glass",
    svg(
      "defs",
      {},
      gradient(sky, [
        [0, "#f6e3ec"],
        [1, "#f8f6f7"],
      ]),
    ),
    rect(0, 0, 300, 400, `url(#${sky})`),
    // The slip, with a torn bottom edge.
    path(
      "M82 40 L218 40 L218 352 L206 344 L194 352 L182 344 L170 352 L158 344 L146 352 L134 344 L122 352 L110 344 L98 352 L82 344 Z",
      { fill: "#fdfcf8", stroke: "#d9d3d6" },
    ),
    rect(112, 62, 76, 9, "#3b4048", { rx: 3 }),
    rect(122, 78, 56, 5, "#b6bbc2", { rx: 2.5 }),
    path("M96 98 L204 98", { stroke: "#a8adb4", "stroke-dasharray": "4 4" }),
    ...line(112, 64),
    ...line(128, 52),
    ...line(144, 70),
    ...line(160, 44),
    path("M96 180 L204 180", { stroke: "#a8adb4", "stroke-dasharray": "4 4" }),
    ...line(194, 40),
    ...line(210, 30),
    rect(96, 232, 44, 10, "#3b4048", { rx: 3 }),
    rect(168, 232, 42, 10, "#3b4048", { rx: 3 }),
    path("M96 262 L204 262", { stroke: "#a8adb4", "stroke-dasharray": "4 4" }),
    rect(96, 276, 70, 6, "#c9cdd3", { rx: 3 }),
    // The lens over the total.
    svg("circle", {
      cx: 188,
      cy: 238,
      r: 34,
      fill: "#c2185b14",
      stroke: "#c2185b",
      "stroke-width": 6,
    }),
    path("M212 262 L246 300", {
      stroke: "#3b4048",
      "stroke-width": 12,
      "stroke-linecap": "round",
    }),
  );
}

/** A queue of support tickets, the top one flagged. */
function drawTickets(key: string): SVGElement {
  const sky = `${key}-sky`;
  const card = (y: number, w: number, tag: string, flagged = false) =>
    svg(
      "g",
      {},
      rect(150 - w / 2, y, w, 52, "#ffffff", {
        rx: 10,
        stroke: flagged ? "#7a4fd6" : "#d5d9de",
        "stroke-width": flagged ? 3 : 1,
      }),
      rect(150 - w / 2 + 14, y + 14, w * 0.45, 7, "#2b3038", { rx: 3 }),
      rect(150 - w / 2 + 14, y + 30, w * 0.62, 6, "#c4cad1", { rx: 3 }),
      rect(150 + w / 2 - 54, y + 13, 40, 16, tag, { rx: 8 }),
    );
  return frame(
    "A stack of support tickets, the top one flagged urgent",
    svg(
      "defs",
      {},
      gradient(sky, [
        [0, "#ebe4f8"],
        [1, "#f7f6fa"],
      ]),
    ),
    rect(0, 0, 300, 400, `url(#${sky})`),
    card(300, 196, "#d5d9de"),
    card(236, 212, "#9fc5f8"),
    card(172, 228, "#f6c86b"),
    card(108, 244, "#e82127", true),
  );
}

/** A terminal of log lines, one of them red, and a pulse line. */
function drawLogs(key: string): SVGElement {
  const sky = `${key}-sky`;
  const lines: [number, string][] = [
    [0.7, "#7f8a96"],
    [0.55, "#7f8a96"],
    [0.8, "#7f8a96"],
    [0.6, "#f6c86b"],
    [0.75, "#7f8a96"],
    [0.85, "#ff8a80"],
    [0.65, "#ff8a80"],
    [0.5, "#7f8a96"],
  ];
  return frame(
    "A terminal of log lines with errors, and a heartbeat line",
    svg(
      "defs",
      {},
      gradient(sky, [
        [0, "#e1efe5"],
        [1, "#f5f7f5"],
      ]),
    ),
    rect(0, 0, 300, 400, `url(#${sky})`),
    rect(40, 70, 220, 230, "#15181d", { rx: 12 }),
    rect(40, 70, 220, 22, "#262a31", { rx: 12 }),
    ...[0, 1, 2].map((i) =>
      svg("circle", {
        cx: 56 + i * 12,
        cy: 81,
        r: 3.5,
        fill: ["#ff5f57", "#febc2e", "#28c840"][i] as string,
      }),
    ),
    ...lines.map(([w, color], i) =>
      rect(56, 108 + i * 22, 188 * w, 8, color, { rx: 3 }),
    ),
    path("M20 340 L110 340 L124 312 L140 368 L156 324 L168 340 L280 340", {
      stroke: "#2f9e44",
      "stroke-width": 4,
      fill: "none",
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }),
  );
}

/** The runway at blue hour from the approach: lights converging, an aircraft's landing lights. */
function drawTower(key: string): SVGElement {
  const sky = `${key}-sky`;
  const lights: SVGElement[] = [];
  // Edge lights converging to the horizon, the green threshold bar, the approach lights.
  for (let i = 0; i < 12; i++) {
    const t = i / 12;
    const y = 400 - (400 - 196) * (1 - (1 - t) ** 2.2);
    const spread = 150 * (1 - t) ** 1.6 + 6;
    const r = 3.4 * (1 - t) + 0.8;
    lights.push(
      svg("circle", { cx: 150 - spread, cy: y, r, fill: "#fff1d6" }),
      svg("circle", { cx: 150 + spread, cy: y, r, fill: "#fff1d6" }),
    );
  }
  for (let k = -6; k <= 6; k++)
    lights.push(
      svg("circle", { cx: 150 + k * 12, cy: 352, r: 3, fill: "#33ff88" }),
    );
  for (let i = 0; i < 5; i++)
    lights.push(
      svg("circle", {
        cx: 150,
        cy: 372 + i * 7,
        r: 2.6 + i * 0.4,
        fill: i === 2 ? "#ffffff" : "#ffe7c2",
      }),
    );
  return frame(
    "A runway at dusk seen from the approach, an airliner with its landing lights on",
    svg(
      "defs",
      {},
      gradient(sky, [
        [0, "#0b1430"],
        [0.55, "#3b4a8a"],
        [0.82, "#e8836a"],
        [1, "#ffbf86"],
      ]),
    ),
    rect(0, 0, 300, 400, `url(#${sky})`),
    rect(0, 196, 300, 204, "#151a23"),
    path("M150 196 L40 400 L260 400 Z", { fill: "#22262e" }),
    ...lights,
    // The tower on the horizon, its cab lit.
    rect(236, 132, 8, 64, "#2a2f38"),
    rect(228, 122, 24, 12, "#3fb6aa", { rx: 3 }),
    svg("circle", { cx: 240, cy: 116, r: 3, fill: "#ff3b30" }),
    // An airliner on short final, landing lights blazing.
    svg("circle", { cx: 128, cy: 108, r: 26, fill: "#fff3cf", opacity: 0.25 }),
    path("M96 106 L164 104 L170 108 L164 112 L96 110 Z", { fill: "#d9dde3" }),
    path("M124 108 L104 128 L114 128 L140 108 Z", { fill: "#c9cdd3" }),
    path("M124 108 L104 90 L114 90 L140 108 Z", { fill: "#c9cdd3" }),
    path("M98 106 L90 94 L96 94 L106 106 Z", { fill: "#0e8a7e" }),
    svg("circle", { cx: 160, cy: 110, r: 4, fill: "#ffffff" }),
  );
}

/** A harbour at first light: the breakwater, its lighthouse, the ferry at the quay. */
function drawOracle(key: string): SVGElement {
  const sky = `${key}-sky`;
  const sea = `${key}-sea`;
  const waves: SVGElement[] = [];
  for (let i = 0; i < 9; i++) {
    const y = 236 + i * 18 + (i * i) / 2;
    const amp = 2 + i * 0.6;
    waves.push(
      path(`M0 ${y} Q 37 ${y - amp} 75 ${y} T 150 ${y} T 225 ${y} T 300 ${y}`, {
        stroke: "#ffffff",
        "stroke-opacity": 0.12 + i * 0.02,
        fill: "none",
      }),
    );
  }
  return frame(
    "A harbour at first light, a lighthouse on the breakwater and a ferry at the quay",
    svg(
      "defs",
      {},
      gradient(sky, [
        [0, "#1c2b4a"],
        [0.5, "#5a6f9c"],
        [0.85, "#e9b48a"],
        [1, "#f6d3a4"],
      ]),
      gradient(sea, [
        [0, "#3d5a7c"],
        [1, "#16253a"],
      ]),
    ),
    rect(0, 0, 300, 400, `url(#${sky})`),
    rect(0, 214, 300, 186, `url(#${sea})`),
    ...waves,
    // The breakwater reaching out from the right, the lighthouse at its head.
    path("M300 226 L170 226 L162 236 L300 236 Z", { fill: "#2a3140" }),
    path("M182 226 L186 150 L198 150 L202 226 Z", { fill: "#eef0f4" }),
    rect(184, 168, 16, 9, "#c2453a"),
    rect(185, 196, 15, 9, "#c2453a"),
    rect(181, 138, 22, 13, "#2a3140", { rx: 2 }),
    svg("circle", { cx: 192, cy: 144, r: 5, fill: "#fff3cf" }),
    path("M192 144 L40 112 L40 168 Z", { fill: "#fff3cf", opacity: 0.18 }),
    // The ferry, waiting.
    path("M24 262 L128 262 L118 282 L34 282 Z", { fill: "#eef0f4" }),
    rect(46, 246, 60, 16, "#d9dde3", { rx: 3 }),
    rect(62, 232, 22, 14, "#c9cdd3", { rx: 2 }),
    rect(68, 222, 8, 10, "#b5562d"),
    ...[54, 66, 78, 90].map((x) => rect(x, 251, 7, 5, "#3b4a6a", { rx: 1 })),
    path("M34 282 L118 282 L116 286 L36 286 Z", { fill: "#b5562d" }),
  );
}

/** A torchlit dungeon from above: stone tiles, a key, a locked door, the stairs down. */
function drawUndercroft(key: string): SVGElement {
  const glow = `${key}-glow`;
  const tiles: SVGElement[] = [];
  const map = [
    "##########",
    "#....#...#",
    "#.##.#.#.#",
    "#.#..D.#.#",
    "#.#.####.#",
    "#...#..k.#",
    "###.#.##.#",
    "#...#..#.#",
    "#.###.##.#",
    "#..@...>.#",
    "#.######.#",
    "#........#",
    "##########",
  ];
  map.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const px = x * 30;
      const py = y * 30 + 10;
      tiles.push(
        rect(px, py, 29, 29, ch === "#" ? "#2b2620" : "#5b5246", {
          rx: 2,
        }),
      );
      if (ch === "D")
        tiles.push(rect(px + 4, py + 2, 21, 25, "#c58b2b", { rx: 3 }));
      if (ch === "k")
        tiles.push(
          svg("circle", {
            cx: px + 11,
            cy: py + 15,
            r: 5,
            fill: "none",
            stroke: "#f2c14e",
            "stroke-width": 3,
          }),
          rect(px + 15, py + 13, 10, 4, "#f2c14e"),
        );
      if (ch === ">")
        for (let i = 0; i < 4; i++)
          tiles.push(
            rect(px + 4 + i * 3, py + 5 + i * 5, 21 - i * 6, 4, "#1a1612"),
          );
      if (ch === "@")
        tiles.push(
          svg("circle", { cx: px + 15, cy: py + 10, r: 5, fill: "#f6e7c8" }),
          rect(px + 9, py + 15, 12, 11, "#3e6ae1", { rx: 3 }),
        );
    });
  });
  return frame(
    "A dungeon seen from above by torchlight: corridors, a key, a locked door, and the stairs down",
    svg(
      "defs",
      {},
      svg(
        "radialGradient",
        { id: glow, cx: 0.4, cy: 0.72, r: 0.65 },
        svg("stop", {
          offset: 0,
          "stop-color": "#ffb347",
          "stop-opacity": 0.35,
        }),
        svg("stop", {
          offset: 1,
          "stop-color": "#000000",
          "stop-opacity": 0.75,
        }),
      ),
    ),
    rect(0, 0, 300, 400, "#15120f"),
    ...tiles,
    rect(0, 0, 300, 400, `url(#${glow})`),
  );
}

/** A chapel organ at dusk: its pipes under a rose window, candles lit. */
function drawEvensong(key: string): SVGElement {
  const sky = `${key}-sky`;
  const pipe = `${key}-pipe`;
  const pipes: SVGElement[] = [];
  const heights = [96, 120, 146, 172, 196, 172, 146, 120, 96];
  heights.forEach((ph, i) => {
    const x = 66 + i * 19;
    const top = 330 - ph;
    pipes.push(
      rect(x, top, 14, ph, `url(#${pipe})`, { rx: 3 }),
      path(
        `M${x} ${top + ph - 26} L${x + 7} ${top + ph - 34} L${x + 14} ${top + ph - 26} Z`,
        {
          fill: "#3b2a18",
        },
      ),
    );
  });
  const petals: SVGElement[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    petals.push(
      svg("circle", {
        cx: 150 + Math.cos(a) * 22,
        cy: 92 + Math.sin(a) * 22,
        r: 11,
        fill: ["#c2453a", "#3e6ae1", "#e0a83a", "#2f9e44"][i % 4] as string,
        opacity: 0.85,
      }),
    );
  }
  return frame(
    "A chapel organ at dusk, its pipes under a stained-glass rose window",
    svg(
      "defs",
      {},
      gradient(sky, [
        [0, "#1d1630"],
        [1, "#3a2a3e"],
      ]),
      gradient(
        pipe,
        [
          [0, "#8a7350"],
          [0.45, "#f0d9a0"],
          [1, "#7a6040"],
        ],
        false,
      ),
    ),
    rect(0, 0, 300, 400, `url(#${sky})`),
    svg("circle", {
      cx: 150,
      cy: 92,
      r: 50,
      fill: "#2a1f33",
      stroke: "#6b5470",
      "stroke-width": 4,
    }),
    ...petals,
    svg("circle", { cx: 150, cy: 92, r: 12, fill: "#f6d3a4" }),
    ...pipes,
    rect(52, 330, 196, 70, "#4a3220"),
    rect(70, 344, 160, 10, "#f5efe2", { rx: 2 }),
    ...Array.from({ length: 11 }, (_, i) =>
      rect(76 + i * 14, 344, 6, 6, "#1d1630"),
    ),
    // Candles either side.
    rect(26, 300, 8, 40, "#f5efe2", { rx: 2 }),
    rect(266, 300, 8, 40, "#f5efe2", { rx: 2 }),
    svg("circle", { cx: 30, cy: 294, r: 5, fill: "#ffcf6b" }),
    svg("circle", { cx: 270, cy: 294, r: 5, fill: "#ffcf6b" }),
    svg("circle", { cx: 30, cy: 294, r: 16, fill: "#ffcf6b", opacity: 0.18 }),
    svg("circle", { cx: 270, cy: 294, r: 16, fill: "#ffcf6b", opacity: 0.18 }),
  );
}

/** A code review diff window with additions and deletions. */
function drawReview(key: string): SVGElement {
  const bg = `${key}-bg`;
  const codeLines: SVGElement[] = [];

  const wx = 24;
  const wy = 48;
  const ww = 252;
  const wh = 304;

  const lines = [
    { type: "normal", indent: 0, w: 90 },
    { type: "normal", indent: 2, w: 120 },
    { type: "del", indent: 2, w: 140 },
    { type: "add", indent: 2, w: 155 },
    { type: "normal", indent: 2, w: 80 },
    { type: "normal", indent: 4, w: 110 },
    { type: "del", indent: 4, w: 130 },
    { type: "add", indent: 4, w: 125 },
    { type: "normal", indent: 2, w: 60 },
    { type: "normal", indent: 0, w: 30 },
  ];

  lines.forEach((l, i) => {
    const y = wy + 55 + i * 22;
    const x = wx + 20 + l.indent * 8;
    if (l.type === "del") {
      codeLines.push(
        rect(wx + 8, y - 4, ww - 16, 18, "#e57373", { opacity: 0.16, rx: 2 }),
        rect(wx + 12, y + 4, 6, 2, "#e57373"),
        rect(x, y, l.w, 10, "#e57373", { rx: 2, opacity: 0.85 }),
      );
    } else if (l.type === "add") {
      codeLines.push(
        rect(wx + 8, y - 4, ww - 16, 18, "#81c784", { opacity: 0.16, rx: 2 }),
        rect(wx + 12, y + 4, 6, 2, "#81c784"),
        rect(wx + 14, y + 2, 2, 6, "#81c784"),
        rect(x, y, l.w, 10, "#81c784", { rx: 2, opacity: 0.85 }),
      );
    } else {
      codeLines.push(rect(x, y, l.w, 10, "#90a4ae", { rx: 2, opacity: 0.6 }));
    }
  });

  return frame(
    "A code review diff window with additions in green and deletions in red",
    svg(
      "defs",
      {},
      gradient(bg, [
        [0, "#10141b"],
        [1, "#1a212d"],
      ]),
    ),
    rect(0, 0, 300, 400, `url(#${bg})`),
    rect(wx, wy, ww, wh, "#151922", {
      rx: 8,
      stroke: "#2b3446",
      "stroke-width": 1.5,
    }),
    rect(wx, wy, ww, 32, "#1c222e", { rx: 8 }),
    rect(wx, wy + 24, ww, 8, "#1c222e"),
    svg("circle", { cx: wx + 16, cy: wy + 16, r: 4.5, fill: "#e57373" }),
    svg("circle", { cx: wx + 28, cy: wy + 16, r: 4.5, fill: "#ffb74d" }),
    svg("circle", { cx: wx + 40, cy: wy + 16, r: 4.5, fill: "#81c784" }),
    rect(wx + 60, wy + 8, 90, 18, "#252e3e", { rx: 4 }),
    rect(wx + 72, wy + 14, 66, 6, "#b0bec5", { rx: 2 }),
    ...codeLines,
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
  tower: {
    accent: "#ffb347",
    tagline:
      "Work the tower at night: land them, launch them, keep the runway clean.",
    emblem: "airplane",
    facts: [
      { icon: "landing", text: "One runway, two flows" },
      { icon: "fog", text: "Low visibility" },
      { icon: "radio", text: "Go-around check" },
    ],
    draw: drawTower,
  },
  inbox: {
    accent: "#0e8a7e",
    tagline: "Spot the phishing in a finance lead's mail.",
    emblem: "envelope",
    facts: [
      { icon: "fish", text: "Phishing and fraud" },
      { icon: "translate", text: "Four languages" },
      { icon: "scroll", text: "Long digests" },
    ],
    draw: drawInbox,
  },
  tickets: {
    accent: "#7a4fd6",
    tagline: "Route support tickets and judge their urgency.",
    emblem: "ticket",
    facts: [
      { icon: "headset", text: "Five teams" },
      { icon: "gauge", text: "Urgency, not tone" },
      { icon: "translate", text: "Four languages" },
    ],
    draw: drawTickets,
  },
  logs: {
    accent: "#2f9e44",
    tagline: "Read production logs: page, or let it be.",
    emblem: "terminal",
    facts: [
      { icon: "siren", text: "Page or not" },
      { icon: "gauge", text: "Numbers against a policy" },
      { icon: "scroll", text: "Long windows" },
    ],
    draw: drawLogs,
  },
  review: {
    accent: "#38bdf8",
    tagline:
      "Review pull requests: gate bugs, locate faults, classify defects.",
    emblem: "code",
    facts: [
      { icon: "checkCircle", text: "Test-proven bugs" },
      { icon: "warning", text: "Fault localization" },
      { icon: "terminal", text: "CI triage" },
    ],
    draw: drawReview,
  },
  receipts: {
    accent: "#c2185b",
    tagline: "Approve expense receipts, from the data or the picture.",
    emblem: "receipt",
    facts: [
      { icon: "image", text: "Printed slips" },
      { icon: "eye", text: "Text, picture, or both" },
      { icon: "gauge", text: "Limits and totals" },
    ],
    draw: drawReceipts,
  },
  oracle: {
    accent: "#e07a3f",
    tagline:
      "Will the ferry sail? Forecast it, scored against the true chance.",
    emblem: "lighthouse",
    facts: [
      { icon: "wind", text: "Wind, swell, fog, crew" },
      { icon: "chartScatter", text: "True probabilities" },
      { icon: "waves", text: "Five ways to read a day" },
    ],
    draw: drawOracle,
  },
  undercroft: {
    accent: "#c58b2b",
    tagline: "Crawl a seeded dungeon to the stairs, one move at a time.",
    emblem: "sword",
    facts: [
      { icon: "mapTrifold", text: "ASCII maps and tile pictures" },
      { icon: "key", text: "Keys, doors, monsters" },
      { icon: "footprints", text: "Steps against the optimum" },
    ],
    draw: drawUndercroft,
  },
  evensong: {
    accent: "#9b6bd6",
    tagline:
      "Play the organ: a chord under every note of a hymn, by the rules.",
    emblem: "musicNotes",
    facts: [
      { icon: "pianoKeys", text: "Hear what it chose" },
      { icon: "scales", text: "Rules of harmony" },
      { icon: "ruleBook", text: "Rules written, or by heart" },
    ],
    draw: drawEvensong,
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
