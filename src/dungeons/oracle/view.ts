// The Oracle in the browser: the day as the autopilot read it on the left;
// on the right each question's chance as the autopilot gave it beside the
// true chance and what happened, the run's reliability diagram, and the
// truth gap so far.

import { type Child, h, svg } from "../../ui/dom.ts";
import type { PlayStatus } from "../../ui/store.ts";
import type { CalibrationBin } from "../dungeon.ts";
import type { TextCase } from "../text/cases.ts";
import type { TextRun } from "../text/text-dungeon.ts";
import {
  dayForecasts,
  forecasts,
  oracleState,
  PASS_TRUTH_GAP,
} from "./oracle.ts";
import { calibration, type Forecast, forecastMetrics } from "./score.ts";

/** Marks: blue the outcomes, orange the truth, ink the autopilot. */
const CAME_TRUE = "#2a78d6";
const TRUTH = "#eb6834";
const INK = "#171a20";
const SURFACE = "#ffffff";
const GRID = "#e3e5e8";

const QUESTION_LABEL: Record<string, string> = {
  sails: "She sails",
  on_time: "On time",
  over_200: "Over 200 aboard",
  cafe_opens: "Café opens",
};

const pct = (p: number) => `${Math.round(p * 100)}%`;

function dayDocument(c: TextCase, level: string): HTMLElement {
  const state = oracleState(c, level);
  if (typeof state === "string") {
    const [head = "", ...lines] = state.split("\n");
    return h(
      "article",
      { class: "doc doc-harbour" },
      h("header", {}, h("h3", {}, head)),
      h(
        "ol",
        { class: "harbour-lines" },
        lines.map((line) =>
          h(
            "li",
            { class: line.includes("Captain's note") ? "note" : "" },
            line,
          ),
        ),
      ),
    );
  }
  if (Array.isArray(state))
    return h(
      "article",
      { class: "doc doc-harbour" },
      h("header", {}, h("h3", {}, "Notices this morning")),
      h(
        "ol",
        { class: "harbour-lines" },
        state.map((line) =>
          h(
            "li",
            {
              class:
                typeof line === "string" && line.includes("correction")
                  ? "note"
                  : "",
            },
            String(line),
          ),
        ),
      ),
    );
  const rows = Object.entries(state ?? {}).filter(([k]) => k !== "day");
  return h(
    "article",
    { class: "doc doc-harbour" },
    h(
      "header",
      {},
      h(
        "h3",
        {},
        typeof state === "object" && state && "day" in state
          ? String(state.day)
          : "The day",
      ),
    ),
    h(
      "dl",
      { class: "harbour-table" },
      rows.map(([k, v]) => [
        h("dt", {}, k.replaceAll("_", " ")),
        h("dd", {}, String(v)),
      ]),
    ),
  );
}

/** One question's chance on a 0–100% track: the autopilot's dot, the truth's diamond. */
function track(
  label: string,
  p: number | undefined,
  truth: number | undefined,
  outcome: boolean | undefined,
): HTMLElement {
  const W = 300;
  const x = (v: number) => 8 + v * (W - 16);
  return h(
    "div",
    { class: "odds-row" },
    h(
      "div",
      { class: "odds-head" },
      h("b", {}, label),
      h(
        "span",
        {},
        p === undefined
          ? "—"
          : `autopilot ${pct(p)} · true ${truth === undefined ? "—" : pct(truth)} · ${outcome === undefined ? "" : outcome ? "it happened" : "it did not"}`,
      ),
    ),
    svg(
      "svg",
      {
        viewBox: `0 0 ${W} 22`,
        class: "odds-track",
        role: "img",
        "aria-label":
          p === undefined
            ? `${label}: not answered yet`
            : `${label}: autopilot ${pct(p)}, true chance ${truth === undefined ? "unknown" : pct(truth)}`,
      },
      svg("rect", { x: 8, y: 10, width: W - 16, height: 2, rx: 1, fill: GRID }),
      ...[0, 0.5, 1].map((v) =>
        svg("rect", {
          x: x(v) - 0.5,
          y: 6,
          width: 1,
          height: 10,
          fill: "#c9cdd3",
        }),
      ),
      truth !== undefined && p !== undefined
        ? svg("rect", {
            x: Math.min(x(p), x(truth)),
            y: 9,
            width: Math.abs(x(p) - x(truth)),
            height: 4,
            fill: "#eb683433",
          })
        : null,
      truth !== undefined && p !== undefined
        ? svg("path", {
            d: `M${x(truth)} 4 L${x(truth) + 7} 11 L${x(truth)} 18 L${x(truth) - 7} 11 Z`,
            fill: TRUTH,
            stroke: SURFACE,
            "stroke-width": 2,
          })
        : null,
      p !== undefined
        ? svg("circle", {
            cx: x(p),
            cy: 11,
            r: 5,
            fill: INK,
            stroke: SURFACE,
            "stroke-width": 2,
          })
        : null,
    ),
  );
}

/** The run's reliability diagram: outcomes and true chances per bin of the autopilot's chance. */
function reliability(f: Forecast[], bins: CalibrationBin[]): HTMLElement {
  const W = 320;
  const H = 230;
  const L = 38;
  const R = 10;
  const T = 10;
  const B = 34;
  const x = (v: number) => L + v * (W - L - R);
  const y = (v: number) => H - B - v * (H - T - B);
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const label = (tx: number, ty: number, text: string, anchor = "middle") => {
    const t = svg("text", {
      x: tx,
      y: ty,
      "text-anchor": anchor,
      class: "chart-tick",
    });
    t.textContent = text;
    return t;
  };
  const tip = (text: string) => {
    const t = svg("title", {});
    t.textContent = text;
    return t;
  };
  const r = (n: number) => 4 + Math.min(4, Math.sqrt(n));
  return h(
    "figure",
    { class: "reliability" },
    h(
      "figcaption",
      {},
      h("b", {}, "Reliability so far"),
      h(
        "span",
        { class: "chart-legend" },
        h("i", { class: "key key-observed", "aria-hidden": "true" }),
        "came true",
        h("i", { class: "key key-truth", "aria-hidden": "true" }),
        "true chance",
      ),
    ),
    svg(
      "svg",
      {
        viewBox: `0 0 ${W} ${H}`,
        class: "reliability-chart",
        role: "img",
        "aria-label": `Reliability diagram over ${f.length} forecasts; the table below gives each bin.`,
      },
      ...ticks.flatMap((v) => [
        svg("rect", {
          x: L,
          y: y(v) - 0.5,
          width: W - L - R,
          height: 1,
          fill: GRID,
        }),
        label(L - 6, y(v) + 3.5, pct(v), "end"),
        label(x(v), H - B + 14, pct(v)),
      ]),
      label((L + W - R) / 2, H - 4, "the autopilot's chance"),
      // Perfect calibration: what comes true matches what was said.
      svg("line", {
        x1: x(0),
        y1: y(0),
        x2: x(1),
        y2: y(1),
        stroke: "#9aa0a8",
        "stroke-width": 1,
      }),
      // Every forecast, as a rug along the bottom.
      ...f.map((one) =>
        svg("rect", {
          x: x(one.p) - 0.5,
          y: H - B - 7,
          width: 1,
          height: 7,
          fill: "#6b707780",
        }),
      ),
      ...bins.flatMap((bin) => {
        const cx = x(bin.forecast);
        const detail = `${pct(bin.from)}–${pct(bin.to)}: ${bin.n} forecast${bin.n === 1 ? "" : "s"}, autopilot ${pct(bin.forecast)}, came true ${pct(bin.observed)}${bin.truth === undefined ? "" : `, true chance ${pct(bin.truth)}`}`;
        const s = r(bin.n) + 1;
        return [
          bin.truth === undefined
            ? null
            : svg(
                "g",
                {},
                tip(detail),
                svg("path", {
                  d: `M${cx} ${y(bin.truth) - s} L${cx + s} ${y(bin.truth)} L${cx} ${y(bin.truth) + s} L${cx - s} ${y(bin.truth)} Z`,
                  fill: TRUTH,
                  stroke: SURFACE,
                  "stroke-width": 2,
                }),
                svg("circle", {
                  cx,
                  cy: y(bin.truth),
                  r: 11,
                  fill: "transparent",
                }),
              ),
          svg(
            "g",
            {},
            tip(detail),
            svg("circle", {
              cx,
              cy: y(bin.observed),
              r: r(bin.n),
              fill: CAME_TRUE,
              stroke: SURFACE,
              "stroke-width": 2,
            }),
            svg("circle", {
              cx,
              cy: y(bin.observed),
              r: 11,
              fill: "transparent",
            }),
          ),
        ];
      }),
    ),
    h(
      "table",
      { class: "visually-hidden" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          ["Bin", "Forecasts", "Autopilot", "Came true", "True chance"].map(
            (c) => h("th", {}, c),
          ),
        ),
      ),
      h(
        "tbody",
        {},
        bins.map((bin) =>
          h(
            "tr",
            {},
            h("td", {}, `${pct(bin.from)}–${pct(bin.to)}`),
            h("td", {}, String(bin.n)),
            h("td", {}, pct(bin.forecast)),
            h("td", {}, pct(bin.observed)),
            h("td", {}, bin.truth === undefined ? "—" : pct(bin.truth)),
          ),
        ),
      ),
    ),
  );
}

function figure(label: string, value: Child, note?: string): HTMLElement {
  return h(
    "div",
    { class: "fact" },
    h("span", {}, label),
    h("b", {}, value),
    note ? h("small", {}, note) : null,
  );
}

/** While a decision is out, the day being asked; otherwise the one just answered, with the truth. */
export function oracleView(run: TextRun, status: PlayStatus): HTMLElement {
  const answered = status !== "deciding" && run.index > 0;
  const index = answered
    ? run.index - 1
    : Math.min(run.index, run.cases.length - 1);
  const c = run.cases[index];
  if (!c) return h("div", {});
  const answers = answered ? run.answers[index] : undefined;
  const all = forecasts(run);
  const metrics = forecastMetrics(all);
  /** A day's own truth gap, scored as the run is. */
  const gapOf = (i: number) =>
    forecastMetrics(dayForecasts(run.cases[i], run.answers[i])).truth_gap;
  const gap = answered ? gapOf(index) : undefined;
  return h(
    "div",
    { class: "text-case oracle" },
    h(
      "div",
      { class: "crossing-head" },
      h(
        "span",
        { class: "eyebrow" },
        `Day ${index + 1} of ${run.cases.length} · set ${run.set.name}`,
      ),
      gap !== undefined
        ? h(
            "span",
            { class: `verdict ${gap <= PASS_TRUTH_GAP ? "ok" : "bad"}` },
            `${Math.round(gap * 100)} point${Math.round(gap * 100) === 1 ? "" : "s"} from the truth`,
          )
        : h(
            "span",
            { class: "verdict pending" },
            status === "deciding"
              ? "Forecasting…"
              : status === "failed"
                ? "No answer"
                : "Up next",
          ),
    ),
    h(
      "div",
      { class: "oracle-grid" },
      dayDocument(c, run.level),
      h(
        "aside",
        { class: "oracle-side" },
        h(
          "div",
          { class: "odds" },
          Object.keys(c.truth).map((q) => {
            const a = answers?.[q];
            return track(
              QUESTION_LABEL[q] ?? q,
              a?.type === "noul" ? a.noul : undefined,
              answered ? c.odds?.[q] : undefined,
              answered ? c.truth[q] === true : undefined,
            );
          }),
        ),
        reliability(all, calibration(all)),
        h(
          "div",
          { class: "facts oracle-figures" },
          figure(
            "Truth gap so far",
            metrics.truth_gap === undefined
              ? "—"
              : metrics.truth_gap.toFixed(3),
            `pass at ${PASS_TRUTH_GAP.toFixed(2)} or under`,
          ),
          figure(
            "Brier · the oracle's",
            metrics.brier === undefined || metrics.oracle_brier === undefined
              ? "—"
              : `${metrics.brier.toFixed(3)} · ${metrics.oracle_brier.toFixed(3)}`,
          ),
        ),
      ),
    ),
    h(
      "ol",
      { class: "case-strip", "aria-label": "Days" },
      run.cases.map((_, i) => {
        const g = gapOf(i);
        const state =
          g !== undefined
            ? g <= PASS_TRUTH_GAP
              ? "ok"
              : "bad"
            : i === index
              ? "now"
              : "";
        return h("li", {
          class: state,
          title: run.records[i]?.summary ?? `Day ${i + 1}`,
        });
      }),
    ),
  );
}
