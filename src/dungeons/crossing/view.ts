// The Crossing dungeon in the browser: the road up to the stop line, the
// car at its distance, the signal, and every case's result so far.

import { type Child, h, svg } from "../../ui/dom.ts";
import type { PlayStatus } from "../../ui/store.ts";
import type { CrossingCase, CrossingRun } from "./crossing.ts";
import { STOP_WITHIN_M } from "./crossing.ts";

/** Meters of road drawn before the line. */
const SPAN_M = 12;
const WIDTH = 640;
const LINE_X = 540;
const SCALE = (LINE_X - 40) / SPAN_M;

const SIGNAL_COLOR = { red: "#e82127", amber: "#f0b429", green: "#1fa463" };

function scene(c: CrossingCase): SVGElement {
  const carFront = LINE_X - Math.min(c.bumperToLine, SPAN_M) * SCALE;
  const zone = STOP_WITHIN_M * SCALE;
  const light = (color: keyof typeof SIGNAL_COLOR, y: number) =>
    svg("circle", {
      cx: 600,
      cy: y,
      r: 9,
      fill: c.signal === color ? SIGNAL_COLOR[color] : "#3a3f47",
    });
  return svg(
    "svg",
    {
      viewBox: `0 0 ${WIDTH} 170`,
      class: "crossing-scene",
      role: "img",
      "aria-label": `${c.signal} signal, bumper ${c.bumperToLine} m from the line`,
    },
    svg("rect", { x: 0, y: 70, width: WIDTH, height: 70, fill: "#d9dce1" }),
    svg("rect", { x: 0, y: 104, width: WIDTH, height: 2, fill: "#ffffff" }),
    svg("rect", {
      x: LINE_X - zone,
      y: 70,
      width: zone,
      height: 70,
      fill: "#e8212714",
    }),
    svg("rect", { x: LINE_X, y: 70, width: 5, height: 70, fill: "#ffffff" }),
    svg("rect", {
      x: carFront - 64,
      y: 110,
      width: 64,
      height: 26,
      rx: 8,
      fill: "#171a20",
    }),
    svg("rect", {
      x: carFront - 22,
      y: 114,
      width: 14,
      height: 18,
      rx: 3,
      fill: "#9aa5b4",
    }),
    svg("rect", {
      x: 586,
      y: 10,
      width: 28,
      height: 76,
      rx: 7,
      fill: "#171a20",
    }),
    light("red", 26),
    light("amber", 48),
    light("green", 70),
    ...Array.from({ length: SPAN_M / 2 + 1 }, (_, i) => {
      const meters = i * 2;
      const text = svg("text", {
        x: LINE_X - meters * SCALE,
        y: 160,
        "text-anchor": "middle",
        class: "crossing-tick",
      });
      text.textContent = meters === 0 ? "line" : `${meters} m`;
      return text;
    }),
  );
}

function fact(label: string, value: Child): HTMLElement {
  return h("div", { class: "fact" }, h("span", {}, label), h("b", {}, value));
}

/** While a decision is out, the case being asked; otherwise the case just answered, with its result. */
export function crossingView(
  run: CrossingRun,
  status: PlayStatus,
): HTMLElement {
  const answered = status !== "deciding" && run.index > 0;
  const index = answered
    ? run.index - 1
    : Math.min(run.index, run.cases.length - 1);
  const c = run.cases[index];
  const record = answered ? run.records[index] : undefined;
  if (!c) return h("div", {});
  return h(
    "div",
    { class: "crossing" },
    h(
      "div",
      { class: "crossing-head" },
      h(
        "span",
        { class: "eyebrow" },
        `Case ${index + 1} of ${run.cases.length}`,
      ),
      record
        ? h(
            "span",
            {
              class: `verdict ${record.correct ? "ok" : "bad"}`,
            },
            record.correct ? "Correct" : (record.violation ?? "Wrong"),
          )
        : h(
            "span",
            { class: "verdict pending" },
            status === "deciding"
              ? "Deciding…"
              : status === "failed"
                ? "No answer"
                : "Up next",
          ),
    ),
    scene(c),
    h(
      "div",
      { class: "facts" },
      fact("Signal", c.signal),
      fact("Bumper to line", `${c.bumperToLine.toFixed(1)} m`),
      fact("Speed", `${c.speed.toFixed(1)} m/s`),
      fact("Answer", answered ? (run.answers[index] ?? "—") : "—"),
      fact("Expected", answered ? c.expected : "—"),
    ),
    h(
      "ol",
      { class: "case-strip", "aria-label": "Cases" },
      run.cases.map((_, i) => {
        const r = run.records[i];
        const state = r ? (r.correct ? "ok" : "bad") : i === index ? "now" : "";
        return h("li", { class: state, title: r?.summary ?? `Case ${i + 1}` });
      }),
    ),
  );
}
