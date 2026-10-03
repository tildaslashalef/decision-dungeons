// Evensong in the browser: the hymn on two staves (the melody above, the
// chosen bass below, a numeral under each chord, faults in red), how sure
// the organist was of the last chord, and an organ to hear what it played.

import { shownCase } from "../../ui/browse.ts";
import { h, svg } from "../../ui/dom.ts";
import type { PlayStatus } from "../../ui/store.ts";
import type { Browse } from "../../ui/views.ts";
import type { EvensongRun } from "./evensong.ts";
import { LETTERS, spell } from "./music.ts";
import { play } from "./organ.ts";

/** Whether each new chord is played as it is chosen; a person turns it on. */
let listening = false;
let heard = "";

const STEP_PX = 5;
const W = 760;
const LEFT = 64;
const TREBLE_BOTTOM = 92;
const BASS_BOTTOM = 196;

/** A spelled note's place on the staff, in diatonic steps from C0. */
function staffPos(name: string): number {
  const m = /^([A-G])[#b]*(-?\d)$/.exec(name);
  return LETTERS.indexOf(m?.[1] ?? "C") + 7 * Number(m?.[2] ?? 0);
}

function staff(bottom: number): SVGElement[] {
  return Array.from({ length: 5 }, (_, i) =>
    svg("rect", {
      x: LEFT - 14,
      y: bottom - i * STEP_PX * 2 - 0.5,
      width: W - LEFT + 4,
      height: 1,
      fill: "#9aa0a8",
    }),
  );
}

/** A note head with its accidental and any ledger lines, on a staff whose bottom line is `bottomPos`. */
function head(
  x: number,
  name: string,
  bottom: number,
  bottomPos: number,
  color: string,
): SVGElement[] {
  const pos = staffPos(name);
  const y = bottom - (pos - bottomPos) * STEP_PX;
  const out: SVGElement[] = [];
  for (let p = bottomPos - 2; p >= pos; p -= 2)
    out.push(
      svg("rect", {
        x: x - 10,
        y: bottom - (p - bottomPos) * STEP_PX - 0.5,
        width: 20,
        height: 1,
        fill: "#9aa0a8",
      }),
    );
  for (let p = bottomPos + 10; p <= pos; p += 2)
    out.push(
      svg("rect", {
        x: x - 10,
        y: bottom - (p - bottomPos) * STEP_PX - 0.5,
        width: 20,
        height: 1,
        fill: "#9aa0a8",
      }),
    );
  out.push(
    svg("ellipse", {
      cx: x,
      cy: y,
      rx: 6.4,
      ry: 4.6,
      fill: color,
      transform: `rotate(-20 ${x} ${y})`,
    }),
  );
  const acc = name.includes("#") ? "♯" : name.includes("b") ? "♭" : "";
  if (acc) {
    const t = svg("text", {
      x: x - 16,
      y: y + 4,
      class: "es-acc",
      fill: color,
    });
    t.textContent = acc;
    out.push(t);
  }
  return out;
}

function score(
  run: EvensongRun,
  current: number,
  select?: (index: number) => void,
): SVGElement {
  const { tune } = run;
  const n = tune.melody.length;
  const gap = (W - LEFT - 30) / Math.max(1, n - 1);
  const x = (i: number) => LEFT + 10 + i * gap;
  const parts: SVGElement[] = [...staff(TREBLE_BOTTOM), ...staff(BASS_BOTTOM)];
  const label = (y: number, text: string) => {
    const t = svg("text", { x: 4, y, class: "es-label" });
    t.textContent = text;
    return t;
  };
  parts.push(
    label(TREBLE_BOTTOM - 16, "melody"),
    label(BASS_BOTTOM - 16, "bass"),
  );
  // Bar lines after each phrase.
  for (const end of tune.phraseEnds)
    parts.push(
      svg("rect", {
        x: end === n - 1 ? W - 12 : (x(end) + x(end + 1)) / 2,
        y: TREBLE_BOTTOM - 40,
        width: end === n - 1 ? 3 : 1,
        height: BASS_BOTTOM - TREBLE_BOTTOM + 40,
        fill: "#9aa0a8",
      }),
    );
  if (current < n)
    parts.push(
      svg("rect", {
        x: x(current) - 16,
        y: 20,
        width: 32,
        height: BASS_BOTTOM + 40,
        rx: 8,
        fill: "#3e6ae118",
      }),
    );
  // While cases can be picked, each placed chord's column is a click target.
  if (select)
    run.placed.forEach((_, i) => {
      const target = svg("rect", {
        x: x(i) - 18,
        y: 20,
        width: 36,
        height: BASS_BOTTOM + 40,
        fill: "transparent",
        class: "es-pick",
      });
      target.addEventListener("click", () => select(i));
      parts.push(target);
    });
  tune.melody.forEach((note, i) => {
    const placed = run.placed[i];
    const bad = (run.faults[i]?.length ?? 0) > 0;
    const ink = placed ? (bad ? "#c62828" : "#171a20") : "#b8bcc3";
    parts.push(
      ...head(x(i), spell(tune.key, note.midi), TREBLE_BOTTOM, 30, ink),
    );
    if (placed) {
      parts.push(
        ...head(x(i), spell(tune.key, placed.bass), BASS_BOTTOM, 18, ink),
      );
      const t = svg("text", {
        x: x(i),
        y: BASS_BOTTOM + 34,
        "text-anchor": "middle",
        class: `es-numeral${bad ? " bad" : ""}`,
      });
      t.textContent = placed.option.id;
      const title = svg("title", {});
      title.textContent = run.records[i]?.summary ?? "";
      t.appendChild(title);
      parts.push(t);
    }
  });
  return svg(
    "svg",
    {
      viewBox: `0 0 ${W} ${BASS_BOTTOM + 48}`,
      class: "es-score",
      role: "img",
      "aria-label": `The hymn in ${tune.key.name}: ${run.records.map((r) => r.summary).join("; ") || "no chords yet"}`,
    },
    ...parts,
  );
}

function hesitation(run: EvensongRun, index: number): HTMLElement | null {
  const ps = run.probabilities[index];
  const chosen = run.placed[index]?.option.id;
  if (!chosen) return null;
  const rows = ps
    ? Object.entries(ps).sort((a, b) => b[1] - a[1])
    : [[chosen, 1] as [string, number]];
  return h(
    "div",
    { class: "es-hesitation" },
    h("b", {}, ps ? "How sure the organist was" : "The organist's chord"),
    rows.map(([id, p]) =>
      h(
        "div",
        { class: `es-bar${id === chosen ? " chosen" : ""}` },
        h("span", {}, id),
        h(
          "i",
          { class: "es-track" },
          h("u", { class: "es-fill", style: `width:${Math.round(p * 100)}%` }),
        ),
        h("small", {}, ps ? `${Math.round(p * 100)}%` : ""),
      ),
    ),
  );
}

export function evensongView(
  run: EvensongRun,
  status: PlayStatus,
  browse: Browse = {},
): HTMLElement {
  const n = run.tune.melody.length;
  const done = run.placed.length;
  // The chord shown: the one just placed, or one a person picked.
  const shown = shownCase(done, n, status, browse);
  const last = shown.answered ? shown.index : done - 1;
  const lastFaults = run.faults[last] ?? [];
  // Play each new chord as it lands, once a person has turned the organ on.
  const now = `${run.level}:${run.seed}:${done}`;
  if (listening && done > 0 && heard !== now && status !== "deciding") {
    heard = now;
    play(run.tune, run.placed.slice(-1));
  }
  const listen = h(
    "button",
    {
      type: "button",
      class: `btn es-listen${listening ? " on" : ""}`,
      "aria-pressed": listening ? "true" : "false",
      onclick: (event: Event) => {
        listening = !listening;
        heard = now;
        (event.currentTarget as HTMLElement).classList.toggle("on", listening);
        (event.currentTarget as HTMLElement).setAttribute(
          "aria-pressed",
          String(listening),
        );
        if (listening && done) play(run.tune, run.placed.slice(-1));
      },
    },
    "Organ on each chord",
  );
  const whole = h(
    "button",
    {
      type: "button",
      class: "btn btn-primary es-play",
      disabled: done === 0,
      onclick: () => play(run.tune, run.placed),
    },
    done === n ? "Play the hymn" : "Play so far",
  );
  return h(
    "div",
    { class: "evensong" },
    h(
      "div",
      { class: "crossing-head" },
      h(
        "span",
        { class: "eyebrow" },
        `Note ${status === "deciding" ? Math.min(done + 1, n) : Math.max(1, last + 1)} of ${n} · ${run.tune.key.name} · seed ${run.seed}`,
      ),
      status === "deciding"
        ? h("span", { class: "verdict pending" }, "At the keys…")
        : done === 0
          ? h("span", { class: "verdict pending" }, "Up next")
          : lastFaults.length
            ? h(
                "span",
                { class: "verdict bad" },
                lastFaults[0]?.text ?? "Fault",
              )
            : h(
                "span",
                { class: "verdict ok" },
                `${run.placed[last]?.option.id} · clean`,
              ),
    ),
    score(run, status === "deciding" ? done : Math.max(0, last), browse.select),
    h(
      "div",
      { class: "es-below" },
      hesitation(run, last) ?? h("div", { class: "es-hesitation" }),
      h(
        "div",
        { class: "es-side" },
        h("div", { class: "es-buttons" }, whole, listen),
        h(
          "ol",
          // Newest first, numbered by note.
          { class: "uc-log", reversed: true, start: run.records.length },
          run.records
            .slice()
            .reverse()
            .slice(0, 4)
            .map((r) =>
              h("li", { class: r.violation ? "bad" : "" }, r.summary),
            ),
        ),
      ),
    ),
  );
}
