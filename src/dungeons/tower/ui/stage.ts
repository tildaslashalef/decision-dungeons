// Night Tower's full-screen play: the airport in 3D, flight strips, the
// radio, and the decision loop. The simulation is light, so it runs here
// in fixed 50 ms steps, at 1×, 4×, or 16× the clock, and stops at each
// question: the run is exactly the headless one of the same seed and
// answers. Positions between steps are interpolated for drawing only.

import "./tower.css";
import {
  ArrowLeft,
  Bug,
  Pause,
  PlaneLanding,
  PlaneTakeoff,
  Play,
  RotateCcw,
  Video,
} from "lucide";
import type { Answers, Decision } from "../../../contract/answer.ts";
import { ApiError, api } from "../../../ui/api.ts";
import { h, icon, replace } from "../../../ui/dom.ts";
import { DEBUG_HISTORY, type DebugEntry } from "../../../ui/store.ts";
import { runSwitcher } from "../../../ui/switcher.ts";
import type { StageContext } from "../../driving/ui/stage.ts";
import {
  DT,
  type Flight,
  flightById,
  NM,
  thresholdIn,
  typeOf,
} from "../sim.ts";
import { type TowerRun, tower } from "../tower.ts";
import {
  CAMERA_NAMES,
  type CameraMode,
  type FlightView,
  TowerScene,
} from "./scene.ts";

const SPEEDS = [1, 4, 16];
const CAMERAS: CameraMode[] = ["tower", "final", "overview"];
const HIDDEN = new Set(["scheduled", "circuit", "done"]);
const ARRIVAL_WORDS: Record<string, string> = {
  final: "on final",
  cleared: "cleared to land",
  landing: "landing",
  vacating: "vacating",
  taxi_in: "taxiing in",
  go_around: "going around",
  circuit: "in the circuit",
};
const DEPARTURE_WORDS: Record<string, string> = {
  taxi_out: "taxiing out",
  holding: "ready, holding short",
  lineup: "lining up",
  takeoff: "rolling",
  stopped: "stopped on runway",
  climb: "airborne",
};

const clockOf = (time: number) => {
  const s = 21 * 3600 + Math.floor(time);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}Z`;
};

function pitchOf(f: Flight): number {
  if (f.phase === "final" || f.phase === "cleared") return 0.05;
  if (f.phase === "landing") return f.alt > 1 ? 0.08 : 0;
  if (f.phase === "takeoff") return f.alt > 1 ? 0.14 : 0;
  if (f.phase === "climb" || f.phase === "go_around") return 0.16;
  return 0;
}

export function mountTowerStage(
  root: HTMLElement,
  ctx: StageContext,
): () => void {
  const { store } = ctx;
  let selection = ctx.selection;
  let run: TowerRun = tower.create(selection.seed, selection.level);
  let generation = 0;
  let paused = false;
  let busy = false;
  let finished = false;
  let speed = 4;
  let camera: CameraMode = "tower";
  let acc = 0;
  let last = performance.now();
  let frame = 0;
  let nextId = 1;
  let focusId: string | null = null;
  let banner: { text: string; tone: string; until: number } | null = null;
  let previous = new Map<
    string,
    { x: number; z: number; alt: number; heading: number }
  >();

  const canvas = h("canvas", { class: "tw-canvas" });
  const scene = new TowerScene(canvas);
  const clockText = h("b", {}, clockOf(0));
  const strips = h("div", { class: "tw-strips" });
  const radio = h("ol", { class: "tw-radio", "aria-live": "polite" });
  const bannerBox = h("div", { class: "tw-banner", hidden: true });
  const end = h("div", { class: "tw-end", hidden: true });
  const pilotLabel = h("span", {});
  const pilot = h(
    "button",
    { type: "button", class: "tw-pilot", onclick: () => togglePause() },
    icon(Pause),
    pilotLabel,
  );
  const speedButtons = SPEEDS.map((s) =>
    h(
      "button",
      { type: "button", class: "tw-speed", onclick: () => setSpeed(s) },
      `${s}×`,
    ),
  );
  const cameraButton = h(
    "button",
    {
      type: "button",
      class: "tw-tool",
      title: "Camera (C)",
      onclick: () => cycleCamera(),
    },
    icon(Video),
    h("span", {}, CAMERA_NAMES[camera]),
  );
  const level = tower.levels.find((l) => l.id === selection.level);
  const stage = h(
    "div",
    { class: "tw-stage" },
    canvas,
    h(
      "header",
      { class: "tw-top tw-glass" },
      h(
        "button",
        {
          type: "button",
          class: "tw-tool",
          "aria-label": "Back to the lobby",
          onclick: () => ctx.exit(),
        },
        icon(ArrowLeft),
      ),
      h(
        "div",
        { class: "tw-title" },
        h("b", {}, "Night Tower"),
        h(
          "span",
          {},
          `${level?.title ?? selection.level} · seed ${selection.seed}`,
        ),
      ),
      runSwitcher(store, selection, (change) => ctx.switchTo(change), {
        tone: "dark",
      }),
      h("div", { class: "tw-clock" }, h("span", {}, "Alder Tower"), clockText),
      h(
        "button",
        {
          type: "button",
          class: "tw-tool",
          title: "Restart",
          onclick: () => restart(selection.seed),
        },
        icon(RotateCcw),
      ),
    ),
    bannerBox,
    h(
      "aside",
      { class: "tw-board tw-glass" },
      h("h2", {}, "Flight strips"),
      strips,
    ),
    h(
      "section",
      { class: "tw-radio-box tw-glass" },
      h("h2", {}, "Tower 118.3"),
      radio,
    ),
    h(
      "footer",
      { class: "tw-dock tw-glass" },
      pilot,
      h(
        "div",
        { class: "tw-speeds", role: "group", "aria-label": "Time" },
        speedButtons,
      ),
      cameraButton,
      h(
        "button",
        {
          type: "button",
          class: "tw-tool",
          title: "Debug (N)",
          onclick: () => store.set({ debugOpen: !store.get().debugOpen }),
        },
        icon(Bug),
        h("span", {}, "Debug"),
      ),
    ),
    end,
  );
  replace(root, stage);
  document.body.classList.add("tw-tower");

  const resize = () => scene.resize(canvas.clientWidth, canvas.clientHeight);
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  function setSpeed(s: number): void {
    speed = s;
    for (const [i, b] of speedButtons.entries())
      b.classList.toggle("active", SPEEDS[i] === s);
  }
  setSpeed(speed);

  function cycleCamera(): void {
    camera = CAMERAS[
      (CAMERAS.indexOf(camera) + 1) % CAMERAS.length
    ] as CameraMode;
    replace(cameraButton, icon(Video), h("span", {}, CAMERA_NAMES[camera]));
  }

  function togglePause(): void {
    if (finished) return;
    paused = !paused;
    syncPilot();
  }

  function syncPilot(): void {
    const name = `${selection.decider} · ${selection.model}`;
    pilotLabel.textContent = finished
      ? name
      : paused
        ? `Resume ${name}`
        : `${name} on frequency`;
    replace(pilot, icon(paused || finished ? Play : Pause), pilotLabel);
    pilot.classList.toggle("paused", paused || finished);
  }
  syncPilot();

  function record(entry: DebugEntry): void {
    const rest = store.get().debug.filter((e) => e.id !== entry.id);
    store.set({ debug: [entry, ...rest].slice(0, DEBUG_HISTORY) });
  }

  function show(text: string, tone: string, seconds = 2.5): void {
    banner = { text, tone, until: performance.now() + seconds * 1000 };
    bannerBox.textContent = text;
    bannerBox.className = `tw-banner ${tone}`;
    bannerBox.hidden = false;
  }

  /** One question: the same observe, decide, apply as a headless turn. */
  async function decideNow(token: number): Promise<void> {
    busy = true;
    const t = run.tower;
    const asking =
      flightById(t, t.pendingLand) ?? flightById(t, t.pendingDepart);
    focusId = asking?.id ?? focusId;
    if (asking)
      show(
        asking.kind === "arrival"
          ? `${asking.callsign} · ${(-asking.x / NM).toFixed(1)} nm · threshold in ${Math.round(thresholdIn(asking))} s — land or go around?`
          : `${asking.callsign} ready at the holding point — take off or hold?`,
        "ask",
        30,
      );
    const observed = tower.observe(run);
    let decision: Decision | undefined;
    if (Object.keys(observed.request.questions).length) {
      const entry: DebugEntry = {
        id: nextId++,
        time: new Date().toLocaleTimeString([], { hour12: false }),
        request: observed.request,
      };
      record(entry);
      const started = performance.now();
      try {
        decision = await api.decide({
          dungeon: tower.id,
          decider: selection.decider,
          model: selection.model,
          request: observed.request,
          seed: selection.seed,
        });
      } catch (error) {
        if (token !== generation) return;
        const code = error instanceof ApiError ? error.code : "unavailable";
        const message = error instanceof Error ? error.message : String(error);
        record({ ...entry, error: { code, message } });
        show(`${code}: ${message}`, "alert", 8);
        paused = true;
        busy = false;
        syncPilot();
        return;
      }
      if (token !== generation) return;
      record({ ...entry, decision, roundTripMs: performance.now() - started });
    }
    const answers: Answers = { ...observed.resolved, ...decision?.answers };
    const land = answers.land?.type === "choice" ? answers.land.choice : null;
    const depart =
      answers.depart?.type === "choice" ? answers.depart.choice : null;
    tower.apply(run, answers);
    if (land === "land")
      show(`${asking?.callsign ?? ""} cleared to land`, "ok");
    else if (land === "go_around") show("Go around", "warn");
    else if (depart === "take_off") show("Cleared for take-off", "ok");
    else if (depart === "hold") show("Hold short", "muted", 1.2);
    busy = false;
  }

  function views(alpha: number): FlightView[] {
    return run.tower.flights.map((f) => {
      const p = previous.get(f.id);
      const lerp = (a: number | undefined, b: number) =>
        a === undefined || Math.abs(b - a) > 400 ? b : a + (b - a) * alpha;
      let dh = p ? f.heading - p.heading : 0;
      if (dh > Math.PI) dh -= Math.PI * 2;
      if (dh < -Math.PI) dh += Math.PI * 2;
      return {
        id: f.id,
        type: f.type,
        livery: f.livery,
        x: lerp(p?.x, f.x),
        z: lerp(p?.z, f.z),
        alt: lerp(p?.alt, f.alt),
        heading: p ? p.heading + dh * alpha : f.heading,
        pitch: pitchOf(f),
        landingLights:
          [
            "final",
            "cleared",
            "landing",
            "lineup",
            "takeoff",
            "go_around",
          ].includes(f.phase) ||
          (f.phase === "climb" && f.alt < 300),
        visible: !HIDDEN.has(f.phase),
      };
    });
  }

  let lastEvents = -1;
  let lastStrips = "";
  function hud(): void {
    const t = run.tower;
    clockText.textContent = clockOf(t.time);
    if (t.events.length !== lastEvents) {
      lastEvents = t.events.length;
      replace(
        radio,
        ...t.events
          .slice(-8)
          .map((e) =>
            h(
              "li",
              { class: e.who },
              h("time", {}, clockOf(e.time).slice(0, 8)),
              h(
                "b",
                {},
                e.who === "tower"
                  ? "TWR"
                  : e.who === "alert"
                    ? "ALERT"
                    : "ACFT",
              ),
              h("span", {}, e.text),
            ),
          ),
      );
    }
    const active = t.flights.filter(
      (f) => f.phase !== "scheduled" && f.phase !== "done",
    );
    const key = active
      .map(
        (f) =>
          `${f.id}:${f.phase}:${Math.round(f.kind === "arrival" ? thresholdIn(f) : t.time - (f.holdingSince ?? t.time))}`,
      )
      .join("|");
    if (key === lastStrips) return;
    lastStrips = key;
    const strip = (f: Flight) => {
      const type = typeOf(f);
      const detail =
        f.kind === "arrival"
          ? f.phase === "final" || f.phase === "cleared"
            ? `${(-f.x / NM).toFixed(1)} nm · ${Math.round(thresholdIn(f))} s`
            : (ARRIVAL_WORDS[f.phase] ?? f.phase)
          : f.phase === "holding"
            ? `waiting ${Math.round(t.time - (f.holdingSince ?? t.time))} s`
            : (DEPARTURE_WORDS[f.phase] ?? f.phase);
      return h(
        "li",
        {
          class: `tw-strip ${f.kind} ${f.phase}${f.id === t.pendingLand || f.id === t.pendingDepart ? " asking" : ""}`,
          onclick: () => {
            focusId = f.id;
          },
        },
        h("b", {}, f.callsign),
        h(
          "span",
          { class: "tw-type" },
          `${f.type}${type.wake === "heavy" ? " · H" : type.wake === "light" ? " · L" : ""}`,
        ),
        h(
          "span",
          { class: "tw-state" },
          f.kind === "arrival"
            ? (ARRIVAL_WORDS[f.phase] ?? f.phase)
            : (DEPARTURE_WORDS[f.phase] ?? f.phase),
        ),
        h("span", { class: "tw-detail" }, detail),
      );
    };
    const arrivals = active
      .filter((f) => f.kind === "arrival")
      .sort((a, b) => b.x - a.x);
    const departures = active.filter((f) => f.kind === "departure");
    replace(
      strips,
      h("h3", {}, icon(PlaneLanding), "Arrivals"),
      arrivals.length
        ? h("ol", {}, arrivals.map(strip))
        : h("p", { class: "tw-none" }, "None on frequency"),
      h("h3", {}, icon(PlaneTakeoff), "Departures"),
      departures.length
        ? h("ol", {}, departures.map(strip))
        : h("p", { class: "tw-none" }, "None on frequency"),
    );
  }

  function finish(): void {
    finished = true;
    syncPilot();
    const outcome = tower.outcome(run);
    const m = outcome.metrics;
    const check = run.check;
    replace(
      end,
      h(
        "div",
        { class: `tw-end-card ${outcome.passed ? "pass" : "fail"}` },
        h(
          "span",
          { class: "tw-eyebrow" },
          `${check ? "GO-AROUND CHECK" : "SHIFT COMPLETE"} · ${outcome.passed ? "PASSED" : "FAILED"}`,
        ),
        h(
          "h1",
          {},
          outcome.passed
            ? check
              ? "Sent around, then landed."
              : "A clean shift."
            : outcome.violations
              ? "Incidents on the runway."
              : "Not every flight was handled.",
        ),
        h(
          "p",
          {},
          [
            `${m.landed} landed`,
            `${m.departed} departed`,
            `${m.go_arounds} go-around${m.go_arounds === 1 ? "" : "s"}`,
            `${outcome.violations} incident${outcome.violations === 1 ? "" : "s"}`,
            m.mean_hold_s !== undefined
              ? `held ${m.mean_hold_s} s on average`
              : "",
            `${Math.round((m.sim_s ?? 0) / 60)} minutes`,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
        h(
          "div",
          { class: "tw-end-actions" },
          h(
            "button",
            {
              type: "button",
              class: "tw-primary",
              onclick: () => restart(selection.seed),
            },
            icon(RotateCcw),
            "Work again",
          ),
          h(
            "button",
            {
              type: "button",
              class: "tw-secondary",
              onclick: () => restart(Math.floor(Math.random() * 10_000)),
            },
            "New seed",
          ),
          h(
            "button",
            { type: "button", class: "tw-link", onclick: () => ctx.exit() },
            "Back to the lobby",
          ),
        ),
      ),
    );
    end.hidden = false;
  }

  function restart(seed: number): void {
    generation++;
    selection = { ...selection, seed };
    run = tower.create(seed, selection.level);
    previous = new Map();
    acc = 0;
    finished = false;
    paused = false;
    busy = false;
    focusId = null;
    lastEvents = -1;
    lastStrips = "";
    end.hidden = true;
    store.set({ debug: [] });
    replace(
      stage.querySelector(".tw-title span") as HTMLElement,
      `${level?.title ?? selection.level} · seed ${seed}`,
    );
    syncPilot();
  }

  const tick = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const t = run.tower;
    if (!paused && !busy && !finished) {
      if (t.pendingLand || t.pendingDepart) void decideNow(generation);
      else {
        acc += dt * speed;
        let steps = 0;
        while (acc >= DT && !t.pendingLand && !t.pendingDepart && steps < 400) {
          previous = new Map(
            t.flights.map((f) => [
              f.id,
              { x: f.x, z: f.z, alt: f.alt, heading: f.heading },
            ]),
          );
          tower.step(run, DT);
          acc -= DT;
          steps++;
        }
        if (tower.outcome(run).finished) finish();
      }
    }
    if (banner && performance.now() > banner.until) {
      banner = null;
      bannerBox.hidden = true;
    }
    const all = views(busy || paused ? 1 : Math.min(1, acc / DT));
    const focus =
      all.find((v) => v.id === focusId && v.visible) ??
      all.filter((v) => v.visible && v.x < 0).sort((a, b) => b.x - a.x)[0] ??
      null;
    scene.render(
      now / 1000,
      all,
      camera,
      camera === "final"
        ? (all
            .filter((v) => v.visible && v.x < 0 && v.alt > 5)
            .sort((a, b) => b.x - a.x)[0] ?? focus)
        : focus,
      dt,
    );
    hud();
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  const keys = new AbortController();
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        (event.target as HTMLElement | null)?.closest("input, select, textarea")
      )
        return;
      if (event.key === "c" || event.key === "C") cycleCamera();
      else if (event.key === " ") {
        event.preventDefault();
        togglePause();
      } else if (event.key === "1" || event.key === "2" || event.key === "3")
        setSpeed(SPEEDS[Number(event.key) - 1] as number);
    },
    { signal: keys.signal },
  );

  return () => {
    generation++;
    cancelAnimationFrame(frame);
    keys.abort();
    observer.disconnect();
    scene.dispose();
    document.body.classList.remove("tw-tower");
    root.replaceChildren();
  };
}
