// The driving dungeon's full-screen play: the 3D scene with its HUD
// (navigation card, minimap, driver dock), candidate paths, the JSON
// inspector, and the decision loop. The run lives in a worker
// (sim.worker.ts), so planning never blocks a frame; this module renders
// interpolated snapshots and talks to /api/decide.
//
// Turn-based by default: simulated time waits for each decision, exactly
// as headless runs do. The next decision is asked for while the current
// turn's 0.3 s still plays, so a fast decider never visibly stops the car;
// a slow one lets it ease to a halt. Real-time mode streams snapshots from
// the worker's own clock and asks for decisions on the reference simulator's cadence
// while the car drives on its last answer.

import "./driving.css";
import {
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  Braces,
  Bug,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  type IconNode,
  Map as MapIcon,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Sparkles,
  Timer,
  Video,
  X,
  Zap,
} from "lucide";
import type { Answers, Decision } from "../../../contract/answer.ts";
import type { Request } from "../../../contract/request.ts";
import { ApiError, api } from "../../../ui/api.ts";
import { h, icon, replace } from "../../../ui/dom.ts";
import {
  DEBUG_HISTORY,
  type DebugEntry,
  type Selection,
  type Store,
} from "../../../ui/store.ts";
import { runSwitcher } from "../../../ui/switcher.ts";
import {
  candidateName,
  type Selection as PathSelection,
} from "../decide/selection.ts";
import type { DecisionState } from "../decide/state.ts";
import { driving, worldOf } from "../driving.ts";
import { scenarioById } from "../scenarios.ts";
import type { DrivingPlan } from "../sim/plan.ts";
import { last } from "../world/geometry.ts";
import { generateWorld } from "../world/world.ts";
import { Inspector, type InspectorTab } from "./inspector.ts";
import { Minimap } from "./minimap.ts";
import { Playback } from "./playback.ts";
import type { FromWorker, Snapshot, ToWorker } from "./protocol.ts";
import type { CameraMode } from "./scene/camera.ts";
import { CAMERA_NAMES, DriveScene } from "./scene/scene.ts";

export interface StageContext {
  store: Store;
  selection: Selection;
  /** Leaves the run for the dungeon's lobby. */
  exit(): void;
  /** Starts again with part of the selection changed (the top bar's switches). */
  switchTo(change: Partial<Selection>): void;
}

type Mode = "turn" | "realtime";

/** Turn-based: ask for the next decision once less than this much motion is left to play (s). */
const LOOKAHEAD_S = 0.4;

/** The reference simulator's cadence: four decisions a second near turns, traffic, and lines; 1.5 on clear roads. */
function decisionInterval(state: DecisionState): number {
  const near = Math.max(18, Math.abs(state.speed_mps) * 3);
  const scene = state.scene;
  if (
    state.recovery.active ||
    state.bend_deg > 12 ||
    state.trip?.phase === "merge" ||
    state.trip?.phase === "ramp_turn" ||
    scene.hazard ||
    (scene.intersection && scene.intersection.stop_line_ahead_m < near) ||
    (scene.following && scene.following.gap_m < near) ||
    scene.nearby.some(
      (o) => Math.abs(o.right_m) < 8 && Math.abs(o.ahead_m) < near,
    )
  )
    return 250;
  return 650;
}

const TURN_ICONS: Record<string, IconNode> = {
  uturn: RotateCcw,
  left: CornerUpLeft,
  right: CornerUpRight,
  straight: ArrowUp,
  arrive: Flag,
  merge: CornerUpLeft,
  exit: CornerUpRight,
};

const clock = () => new Date().toLocaleTimeString([], { hour12: false });

/** Something to show on the road once playback reaches simulated second `t`. */
type RoadEvent =
  | { t: number; kind: "candidates"; plan: DrivingPlan }
  | {
      t: number;
      kind: "answer";
      plan: DrivingPlan;
      selection: PathSelection;
      state: DecisionState;
      roundTrip: number | null;
    };

/** Frame times (ms) the page exposes for measurement; the newest few thousand. */
interface FrameProbe {
  frames: number[];
  /** The rendered car's position each frame, x then z. */
  poses: number[];
}

/** Talks to one simulation worker: requests resolve in order with the reply of their kind. */
class SimWorker {
  readonly worker: Worker;
  private waiting = new Map<string, ((message: FromWorker) => void)[]>();
  onStream: (message: FromWorker) => void = () => {};

  constructor() {
    // Bundled and served by the server (src/server/assets.ts).
    this.worker = new Worker("/workers/driving-sim.js", { type: "module" });
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      const queue = this.waiting.get(message.type);
      const resolve = queue?.shift();
      if (resolve) resolve(message);
      else this.onStream(message);
      if (message.type === "error")
        for (const q of this.waiting.values()) q.length = 0;
    };
  }

  send(message: ToWorker): void {
    this.worker.postMessage(message);
  }

  call<T extends FromWorker["type"]>(
    message: ToWorker,
    reply: T,
  ): Promise<Extract<FromWorker, { type: T }>> {
    return new Promise((resolve, reject) => {
      const queue = this.waiting.get(reply) ?? [];
      queue.push((m) => resolve(m as Extract<FromWorker, { type: T }>));
      this.waiting.set(reply, queue);
      const errors = this.waiting.get("error") ?? [];
      errors.push((m) =>
        reject(new Error(m.type === "error" ? m.message : "worker error")),
      );
      this.waiting.set("error", errors);
      this.send(message);
    });
  }

  terminate(): void {
    this.worker.terminate();
  }
}

/** Mounts the driving stage into `root`; returns its unmount. */
export function mountDrivingStage(
  root: HTMLElement,
  ctx: StageContext,
): () => void {
  const { store } = ctx;
  let selection = ctx.selection;
  let sim: SimWorker | null = null;
  let view: Playback | null = null;
  let scene: DriveScene | null = null;
  let mode: Mode = "turn";
  let pendingMode: Mode | null = null;
  /** Bumped by every restart, so a late reply from an old run is dropped. */
  let generation = 0;
  let loading = true;
  let paused = false;
  let finished = false;
  let busy = false;
  let showCandidates = false;
  let nextDecision = 0;
  let errors = 0;
  let nextId = 1;
  let lastDecision: Decision | null = null;
  let lastSelection: PathSelection | null = null;
  let lastRequest: Request | null = null;
  let lastState: DecisionState | null = null;
  let lastRoundTrip: number | null = null;
  /** The decision whose turn is on screen now; the HUD shows it, not one decided ahead. */
  let shown: {
    selection: PathSelection;
    state: DecisionState;
    roundTrip: number | null;
  } | null = null;
  let perception: unknown = {
    status: "Open this tab while driving to see the sensors.",
  };
  let worldView: unknown = { status: "Reading the world…" };
  let roadEvents: RoadEvent[] = [];
  let uiTime = 0;
  let lastNow = performance.now();
  let frame = 0;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let routeVersion = 0;
  const tally = {
    calls: 0,
    resolved: 0,
    inputTokens: 0,
    costUsd: 0,
    latencies: [] as number[],
  };
  const probe: FrameProbe = { frames: [], poses: [] };
  (window as unknown as { __ddFrames?: FrameProbe }).__ddFrames = probe;

  // Elements.
  const canvas = h("canvas", {
    class: "dd-world",
    "aria-label": "Three-dimensional driving world",
  });
  const labels = h("div", {
    class: "dd-vector-labels",
    "aria-label": "Path probabilities",
  });
  const loader = h(
    "div",
    { class: "dd-loader", role: "status", "aria-live": "polite" },
    h("strong", {}, "Getting your drive ready"),
    h("p", {}, "Loading the car and the scenery…"),
    h("span", { class: "dd-spinner", "aria-hidden": "true" }),
  );
  const loaderMessage = loader.querySelector("p") as HTMLParagraphElement;
  const levelSelect = h(
    "select",
    {
      "aria-label": "Level",
      onchange: (e: Event) =>
        restart({ level: (e.target as HTMLSelectElement).value }),
    },
    driving.levels.map((l) => h("option", { value: l.id }, l.title)),
  );
  levelSelect.value = selection.level;
  const seedLabel = h("span", { class: "dd-seed" });
  const topbar = h(
    "header",
    { class: "dd-topbar dd-glass" },
    h(
      "button",
      {
        type: "button",
        class: "dd-back",
        "aria-label": "Back to the lobby",
        title: "Back to the lobby",
        onclick: () => exit(),
      },
      icon(ArrowLeft),
    ),
    h("b", { class: "dd-title" }, "Autopilot driving"),
    h(
      "div",
      { class: "dd-world-picker" },
      levelSelect,
      seedLabel,
      h(
        "button",
        {
          type: "button",
          "aria-label": "New seed",
          title: "New seed",
          onclick: () => restart({ seed: Math.floor(Math.random() * 999_999) }),
        },
        icon(RotateCw),
      ),
    ),
    runSwitcher(store, selection, (change) => ctx.switchTo(change), {
      level: false,
    }),
  );
  const turnIcon = h("span", { class: "dd-turn-icon" });
  const nextManeuver = h("strong", {}, "Continue straight");
  const turnDistance = h("span", {});
  const remaining = h("span", { class: "dd-remaining" });
  const minimap = new Minimap(() => view as Playback);
  const mapToggle = h(
    "button",
    {
      type: "button",
      "aria-label": "Toggle route map",
      "aria-pressed": "true",
      title: "Hide route map",
      onclick: () => {
        minimap.element.hidden = !minimap.element.hidden;
        mapToggle.setAttribute("aria-pressed", String(!minimap.element.hidden));
        mapToggle.title = `${minimap.element.hidden ? "Show" : "Hide"} route map`;
        minimap.constrain();
        minimap.draw();
      },
    },
    icon(MapIcon),
  );
  const navigationHud = h(
    "div",
    { class: "dd-navigation" },
    h(
      "div",
      { class: "dd-navigation-card dd-glass" },
      turnIcon,
      h("div", {}, nextManeuver, turnDistance),
      h("span", { class: "dd-nav-divider" }),
      remaining,
      mapToggle,
    ),
    minimap.element,
  );
  const speed = h("strong", {}, "0");
  const speedLimit = h("b", {}, "50");
  const pilotLabel = h("span", {});
  const pilotButton = h(
    "button",
    {
      type: "button",
      class: "dd-pilot",
      role: "switch",
      "aria-checked": "true",
      title: "Pause or resume the autopilot · P",
      onclick: () => togglePause(),
    },
    icon(Sparkles),
    pilotLabel,
    h("kbd", {}, "P"),
  );
  const candidatesButton = h(
    "button",
    {
      type: "button",
      class: "dd-candidates",
      "aria-label": "Show path candidates",
      "aria-pressed": "false",
      title: "Show path candidates",
      onclick: () => {
        const show = !showCandidates;
        showCandidates = show;
        if (scene) scene.vectors.showCandidates = show;
        candidatesButton.setAttribute("aria-pressed", String(show));
        candidatesButton.title = `${show ? "Hide" : "Show"} path candidates`;
      },
    },
    candidatesIcon(),
  );
  const pilotState = h(
    "span",
    { class: "dd-pilot-state" },
    "Reading the road…",
  );
  const contextMessage = h("span", { class: "dd-context" }, "");
  const cost = h("strong", {}, "$0");
  const modeLabel = h("span", {});
  const modeButton = h(
    "button",
    {
      type: "button",
      title: "Turn-based or real-time",
      onclick: () => setMode(mode === "turn" ? "realtime" : "turn"),
    },
    icon(Timer),
    modeLabel,
  );
  const cameraName = h("span", {}, "Chase");
  const fullscreenButton = h(
    "button",
    {
      type: "button",
      "aria-label": "Enter fullscreen",
      title: "Fullscreen",
      onclick: () => void toggleFullscreen(),
    },
    icon(Maximize),
  );
  const pauseButton = h(
    "button",
    {
      type: "button",
      "aria-label": "Pause simulation",
      title: "Pause · P",
      onclick: () => togglePause(),
    },
    icon(Pause),
  );
  const debugButton = h(
    "button",
    {
      type: "button",
      "aria-label": "Decision debug",
      "aria-pressed": String(store.get().debugOpen),
      title: "Decision debug · N",
      onclick: () => store.set({ debugOpen: !store.get().debugOpen }),
    },
    icon(Bug),
  );
  const dock = h(
    "div",
    { class: "dd-bottom" },
    h(
      "div",
      { class: "dd-dock dd-glass" },
      h(
        "div",
        { class: "dd-speed" },
        h("div", { title: "Current speed" }, speed, h("span", {}, "km/h")),
        h(
          "span",
          { class: "dd-limit", title: "Speed limit" },
          h("small", {}, "LIMIT"),
          speedLimit,
        ),
      ),
      h("span", { class: "dd-dock-divider" }),
      h("div", { class: "dd-pilot-actions" }, pilotButton, candidatesButton),
      h(
        "div",
        { class: "dd-status" },
        pilotState,
        contextMessage,
        h(
          "span",
          { class: "dd-cost", title: "Decider cost reported this run" },
          h("span", {}, "Run"),
          cost,
        ),
      ),
      h("span", { class: "dd-dock-divider" }),
      h(
        "div",
        {
          class: "dd-tools",
          role: "group",
          "aria-label": "View and run controls",
        },
        modeButton,
        h(
          "button",
          {
            type: "button",
            title: "Change camera · C",
            "aria-label": "Change camera",
            onclick: () => changeCamera(),
          },
          icon(Video),
          cameraName,
        ),
        h(
          "button",
          {
            type: "button",
            "aria-label": "Inspect live JSON",
            title: "Inspect live JSON",
            onclick: () => inspector.open(),
          },
          icon(Braces),
        ),
        debugButton,
        fullscreenButton,
        h("span", { class: "dd-divider" }),
        pauseButton,
      ),
    ),
  );
  const pausedOverlay = h(
    "div",
    { class: "dd-paused", hidden: true },
    h(
      "div",
      { class: "dd-glass" },
      h("span", {}, icon(Pause), "Paused"),
      h("p", { class: "dd-paused-reason" }),
      h(
        "button",
        { type: "button", class: "dd-primary", onclick: () => togglePause() },
        "Resume driving",
      ),
    ),
  );
  const pausedReason = pausedOverlay.querySelector(
    ".dd-paused-reason",
  ) as HTMLParagraphElement;
  const arrival = h("div", { class: "dd-arrival dd-glass", hidden: true });
  const crashDialog = h("dialog", {
    class: "dd-crash",
    "aria-label": "Drive ended",
  });
  crashDialog.addEventListener("cancel", (event) => event.preventDefault());
  const toastBox = h("div", {
    class: "dd-toast",
    role: "status",
    hidden: true,
  });
  const inspector = new Inspector(
    inspectData,
    (tab) => `driving-${tab}-${selection.level}-${selection.seed}.json`,
  );
  const stage = h(
    "div",
    { class: "dd-stage" },
    h(
      "main",
      { class: "dd-drive", "aria-label": "3D driving simulator" },
      canvas,
      labels,
    ),
    topbar,
    navigationHud,
    pausedOverlay,
    arrival,
    dock,
    toastBox,
    crashDialog,
    inspector.dialog,
    loader,
  );

  replace(root, stage);
  document.body.classList.add("dd-driving");

  function candidatesIcon(): SVGElement {
    // A fork-of-paths glyph.
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M12 20V3m-3 3 3-3 3 3M12 20C12 14 7 12 3 8m0 3V8h3M12 20c0-6 5-8 9-12m-3 0h3v3",
    );
    const dot = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "circle",
    );
    dot.setAttribute("cx", "12");
    dot.setAttribute("cy", "21");
    dot.setAttribute("r", "1");
    dot.setAttribute("fill", "currentColor");
    dot.setAttribute("stroke", "none");
    svg.append(path, dot);
    return svg;
  }

  function toast(text: string, type: "info" | "error" = "info"): void {
    toastBox.textContent = text;
    toastBox.classList.toggle("error", type === "error");
    toastBox.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastBox.hidden = true;
    }, 4200);
  }

  function record(entry: DebugEntry): void {
    const rest = store.get().debug.filter((e) => e.id !== entry.id);
    store.set({ debug: [entry, ...rest].slice(0, DEBUG_HISTORY) });
  }

  function inspectData(tab: InspectorTab): unknown {
    if (tab === "request")
      return (
        lastDecision?.debug?.request ??
        lastRequest ?? {
          status:
            "No decision yet: every question so far resolved locally, or none was asked.",
        }
      );
    if (tab === "state")
      return lastState ?? { status: "Preparing the driving state…" };
    if (tab === "decision")
      return {
        response: lastDecision,
        selection: lastSelection,
        round_trip_ms: lastRoundTrip,
        run: {
          decisions_asked: tally.calls,
          resolved_locally: tally.resolved,
          input_tokens: tally.inputTokens,
          cost_usd: tally.costUsd,
          recent_latencies_ms: tally.latencies,
        },
        outcome: view?.current.outcome ?? null,
      };
    // Perception and the world live in the worker: show the last reply, ask
    // for the next.
    if (tab === "world") {
      sim?.send({ type: "world" });
      return worldView;
    }
    sim?.send({ type: "perception" });
    return perception;
  }

  function syncPilot(): void {
    const name = `${selection.decider} · ${selection.model}${selection.evaluation ? " · evaluation" : ""}`;
    pilotLabel.textContent = finished
      ? name
      : paused
        ? `Resume ${name}`
        : `${name} engaged`;
    pilotButton.setAttribute("aria-checked", String(!paused && !finished));
    pilotButton.disabled = finished;
    modeLabel.textContent = mode === "turn" ? "Turn-based" : "Real-time";
    modeButton.setAttribute(
      "aria-label",
      mode === "turn"
        ? "Turn-based: time waits for each decision. Switch to real-time"
        : "Real-time: switch to turn-based",
    );
    pauseButton.replaceChildren(icon(paused ? Play : Pause));
    pauseButton.setAttribute(
      "aria-label",
      paused ? "Resume simulation" : "Pause simulation",
    );
    seedLabel.textContent = `seed ${selection.seed}`;
  }

  function pause(reason: string | null): void {
    if (paused || finished) return;
    paused = true;
    if (view) view.paused = true;
    if (mode === "realtime") sim?.send({ type: "realtime", on: false });
    pausedReason.textContent = reason ?? "";
    pausedReason.hidden = !reason;
    pausedOverlay.hidden = false;
    syncPilot();
  }

  function resume(): void {
    if (!paused || finished) return;
    paused = false;
    errors = 0;
    nextDecision = 0;
    if (view) view.paused = false;
    if (mode === "realtime") sim?.send({ type: "realtime", on: true });
    pausedOverlay.hidden = true;
    lastNow = performance.now();
    syncPilot();
  }

  function togglePause(): void {
    if (loading) return;
    if (paused) resume();
    else pause(null);
  }

  /** Switches between turn-based and real-time once no decision is in flight. */
  function setMode(next: Mode): void {
    pendingMode = next === mode ? null : next;
    switchMode();
  }

  function switchMode(): void {
    if (!pendingMode || busy) return;
    mode = pendingMode;
    pendingMode = null;
    nextDecision = 0;
    if (!paused && !finished)
      sim?.send({ type: "realtime", on: mode === "realtime" });
    syncPilot();
    toast(
      mode === "turn"
        ? "Turn-based: simulated time waits for each decision."
        : "Real-time: the car keeps driving while the autopilot thinks.",
    );
  }

  function changeCamera(): void {
    if (!scene) return;
    const modes: CameraMode[] = ["chase", "hood", "map"];
    scene.mode = modes[(modes.indexOf(scene.mode) + 1) % 3] as CameraMode;
    scene.snap = true;
    cameraName.textContent = CAMERA_NAMES[scene.mode];
  }

  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      toast("Use your browser’s fullscreen shortcut.");
    }
  }

  function onFullscreen(): void {
    fullscreenButton.replaceChildren(
      icon(document.fullscreenElement ? Minimize : Maximize),
    );
    fullscreenButton.setAttribute(
      "aria-label",
      document.fullscreenElement ? "Exit fullscreen" : "Enter fullscreen",
    );
  }

  /** Messages the worker sends on its own: real-time ticks, reroutes, new traffic looks. */
  function onStream(message: FromWorker): void {
    if (!view) return;
    if (message.type === "tick") view.push(message.snapshot);
    else if (message.type === "route") view.setRoute(message.route);
    else if (message.type === "looks") view.setLooks(message.looks);
    else if (message.type === "perception") perception = message.data;
    else if (message.type === "world") worldView = message.data;
    else if (message.type === "error") failed(new Error(message.message));
  }

  /** Starts a run in a fresh worker and builds its scene. */
  async function start(): Promise<void> {
    const token = ++generation;
    sim?.terminate();
    sim = new SimWorker();
    sim.onStream = onStream;
    loading = true;
    loader.hidden = false;
    loaderMessage.textContent = "Building the world…";
    const started = await sim.call(
      {
        type: "start",
        seed: selection.seed,
        level: selection.level,
        evaluation: selection.evaluation,
      },
      "started",
    );
    if (token !== generation) return;
    view = new Playback(
      generateWorld(selection.seed, worldOf(selection.level)),
      started.snapshot,
      started.route,
      started.looks,
    );
    routeVersion = started.snapshot.routeVersion;
    if (scene) scene.build(view);
    else scene = new DriveScene(canvas, view, labels);
    scene.vectors.showCandidates = showCandidates;
    minimap.resetView();
    loaderMessage.textContent = "Loading the car and the scenery…";
    try {
      await scene.ready;
      loaderMessage.textContent = "Preparing the road…";
      await scene.prepare();
    } catch (error) {
      console.error("Unable to prepare the driving world", error);
      loaderMessage.textContent =
        "Could not load the drive. Reload to try again.";
      return;
    }
    if (token !== generation) return;
    loading = false;
    loader.hidden = true;
    lastNow = performance.now();
    if (mode === "realtime") sim.send({ type: "realtime", on: true });
    updateHud();
    minimap.draw();
  }

  function restart(change: Partial<Selection> = {}): void {
    selection = { ...selection, ...change };
    store.set({
      selection: { ...store.get().selection, ...change },
      debug: [],
    });
    levelSelect.value = selection.level;
    paused = false;
    finished = false;
    busy = false;
    pendingMode = null;
    nextDecision = 0;
    errors = 0;
    nextId = 1;
    lastDecision = lastSelection = lastRequest = lastState = null;
    lastRoundTrip = null;
    shown = null;
    roadEvents = [];
    Object.assign(tally, {
      calls: 0,
      resolved: 0,
      inputTokens: 0,
      costUsd: 0,
      latencies: [],
    });
    pausedOverlay.hidden = true;
    arrival.hidden = true;
    if (crashDialog.open) crashDialog.close();
    stage.classList.remove("crashed");
    scene?.vectors.clear();
    syncPilot();
    void start();
  }

  function exit(): void {
    ctx.exit();
  }

  /**
   * One decision on the worker's run: observe, ask the server unless every
   * question resolved locally, apply. Returns false when the run changed meanwhile.
   */
  async function decide(): Promise<boolean> {
    const token = generation;
    const worker = sim;
    if (!worker || !view) return false;
    const observed = await worker.call({ type: "observe" }, "observed");
    if (token !== generation) return false;
    view.push(observed.snapshot);
    lastState = observed.state;
    if (observed.plan)
      roadEvents.push({
        t: observed.snapshot.t,
        kind: "candidates",
        plan: observed.plan,
      });
    const request = observed.request;
    const asked = Object.keys(request.questions).length > 0;
    let decision: Decision | null = null;
    if (asked) {
      lastRequest = request;
      const entry: DebugEntry = { id: nextId++, time: clock(), request };
      record(entry);
      const started = performance.now();
      try {
        decision = await api.decide({
          dungeon: driving.id,
          decider: selection.decider,
          model: selection.model,
          request,
          seed: selection.seed,
        });
      } catch (error) {
        if (token !== generation) return false;
        const code = error instanceof ApiError ? error.code : "unavailable";
        const message = error instanceof Error ? error.message : String(error);
        record({ ...entry, error: { code, message } });
        throw new Error(message);
      }
      const roundTrip = performance.now() - started;
      if (token !== generation) return false;
      record({ ...entry, decision, roundTripMs: roundTrip });
      lastDecision = decision;
      lastRoundTrip = Math.round(roundTrip);
      tally.calls++;
      tally.latencies.push(Math.round(roundTrip));
      if (tally.latencies.length > 25) tally.latencies.shift();
      if (decision.usage) tally.inputTokens += decision.usage.inputTokens;
      if (decision.costUsd !== undefined) tally.costUsd += decision.costUsd;
    } else tally.resolved++;
    const answers: Answers = { ...observed.resolved, ...decision?.answers };
    const applied = await worker.call({ type: "apply", answers }, "applied");
    if (token !== generation) return false;
    view.push(applied.snapshot);
    lastSelection = applied.selection;
    errors = 0;
    if (applied.selection && observed.plan)
      roadEvents.push({
        t: applied.snapshot.t,
        kind: "answer",
        plan: observed.plan,
        selection: applied.selection,
        state: observed.state,
        roundTrip: asked ? lastRoundTrip : null,
      });
    return true;
  }

  /** Turn-based: a decision, then the turn's six steps for playback. */
  async function turn(): Promise<void> {
    const token = generation;
    if (!(await decide()) || !sim) return;
    const advanced = await sim.call({ type: "advance" }, "advanced");
    if (token !== generation || !view) return;
    for (const snapshot of advanced.snapshots) view.push(snapshot);
  }

  function failed(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    errors++;
    scene?.vectors.clear();
    toast(message, "error");
    if (mode === "turn" || errors >= 3)
      pause(`${selection.decider} could not decide: ${message}`);
    else
      nextDecision = performance.now() + Math.min(15_000, 1000 * 2 ** errors);
  }

  /** Starts the next decision when one is due; at most one is in flight. */
  function schedule(now: number): void {
    if (busy || paused || finished || !view || view.current.outcome.finished)
      return;
    if (mode === "turn") {
      if (view.buffered >= LOOKAHEAD_S) return;
      // The run may have ended inside the buffered turn.
      if (lastHeadFinished()) return;
      busy = true;
      turn()
        .catch(failed)
        .finally(() => {
          busy = false;
          switchMode();
        });
      return;
    }
    if (now < nextDecision || lastHeadFinished()) return;
    busy = true;
    const started = now;
    decide()
      .then((applied) => {
        if (applied)
          nextDecision =
            started + (lastState ? decisionInterval(lastState) : 650);
      })
      .catch(failed)
      .finally(() => {
        busy = false;
        switchMode();
      });
  }

  /** Whether the newest snapshot on the timeline ends the run. */
  let headOutcome: Snapshot["outcome"] | null = null;
  function lastHeadFinished(): boolean {
    return !!headOutcome?.finished;
  }

  function updateHud(): void {
    if (!view) return;
    const snap = view.current;
    const v = view.player;
    const nav = snap.nav;
    speed.textContent = String(Math.round(Math.abs(v.speed) * 3.6));
    speedLimit.textContent = String(
      Math.round((nav.speed_limit_mps ?? view.world.theme.limit) * 3.6),
    );
    remaining.textContent =
      nav.remaining_m >= 1000
        ? `${(nav.remaining_m / 1000).toFixed(1)} km`
        : `${Math.round(nav.remaining_m)} m`;
    nextManeuver.textContent =
      nav.instruction ??
      (nav.next_turn === "arrive"
        ? view.world.type === "highway"
          ? "Follow Interstate 08"
          : "Destination ahead"
        : nav.next_turn === "straight"
          ? "Continue straight"
          : nav.next_turn === "uturn"
            ? "Make a U-turn"
            : `Turn ${nav.next_turn}`);
    turnDistance.textContent =
      nav.next_turn === "arrive"
        ? "to your destination"
        : `in ${Math.round(nav.turn_distance_m)} m`;
    if (turnIcon.dataset.icon !== nav.next_turn) {
      turnIcon.replaceChildren(icon(TURN_ICONS[nav.next_turn] ?? ArrowUp));
      turnIcon.dataset.icon = nav.next_turn;
    }
    const waiting = mode === "turn" && busy && view.buffered <= 0.001;
    const chosen = shown
      ? shown.state.vectors[shown.selection.choice]
      : undefined;
    const confidence = shown?.selection.confidence ?? Number.NaN;
    pilotState.textContent = finished
      ? snap.crash
        ? "Drive ended"
        : "Run finished"
      : paused
        ? "Paused"
        : waiting
          ? `${selection.decider} is deciding…`
          : !shown
            ? "Reading the road…"
            : `${candidateName(chosen)}${Number.isFinite(confidence) ? ` · ${Math.round(confidence * 100)}%` : ""}`;
    let context = "";
    if (!finished && !paused) {
      const target = Math.round((v.target ?? 0) * 3.6);
      if (snap.brakeReason) context = `Safety brake · ${snap.brakeReason}`;
      else if (waiting) context = "Time waits for the decision";
      else if (shown) {
        context = `${target} km/h target${shown.roundTrip !== null ? ` · ${shown.roundTrip} ms` : ""}`;
        if (v.speed < 0.5 && (v.target ?? 0) < 0.5)
          context =
            shown.roundTrip !== null
              ? `${selection.decider} chose to wait · reassessing`
              : "Only stop is available";
      }
      if (nav.rerouted)
        context = "Route recalculated · continuing to your destination";
      else if (snap.recovering)
        context = snap.onRoad
          ? "Returning to the route"
          : "Finding a way back onto the road";
    }
    contextMessage.textContent = context;
    cost.textContent = tally.costUsd ? `$${tally.costUsd.toFixed(6)}` : "$0";
    debugButton.setAttribute("aria-pressed", String(store.get().debugOpen));
    syncPilot();
  }

  function showOutcome(): void {
    if (!view) return;
    const snap = view.current;
    const outcome = snap.outcome;
    finished = true;
    if (mode === "realtime") sim?.send({ type: "realtime", on: false });
    syncPilot();
    if (snap.crash) {
      stage.classList.add("crashed");
      const crash = snap.crash;
      replace(
        crashDialog,
        h("span", { class: "dd-crash-symbol" }, icon(X)),
        h("span", { class: "dd-eyebrow" }, "DRIVE ENDED"),
        h("h1", {}, "Game over."),
        h(
          "p",
          {},
          {
            building: "The car hit a building.",
            pedestrian: "The car struck a pedestrian.",
            car: "The car collided with another car.",
            motorcycle: "The car collided with a motorcycle.",
          }[crash.type] ?? `The car hit a ${crash.type}.`,
        ),
        h(
          "div",
          { class: "dd-crash-stats" },
          h(
            "div",
            {},
            h("strong", {}, String(Math.round(crash.impact_speed_mps * 3.6))),
            h("span", {}, "km/h at impact"),
          ),
          h(
            "div",
            {},
            h("strong", {}, String(Math.round(snap.distance))),
            h("span", {}, "meters driven"),
          ),
          h(
            "div",
            {},
            h("strong", {}, String(outcome.metrics.decisions ?? 0)),
            h("span", {}, "decisions"),
          ),
        ),
        h(
          "button",
          { type: "button", class: "dd-primary", onclick: () => restart() },
          icon(RotateCcw),
          "Restart drive",
        ),
        h(
          "button",
          { type: "button", class: "dd-secondary", onclick: () => exit() },
          "Back to the lobby",
          icon(ArrowUpRight),
        ),
      );
      crashDialog.show();
      return;
    }
    const check = scenarioById(selection.level);
    const m = outcome.metrics;
    const arrived = m.arrived === 1;
    const violations = `${outcome.violations} violation${outcome.violations === 1 ? "" : "s"}`;
    const title = check
      ? outcome.passed
        ? check.passTitle
        : check.failTitle
      : arrived
        ? outcome.passed
          ? "You made it."
          : "Arrived, with violations."
        : "Out of time.";
    const eyebrow = check
      ? `${check.name} ${outcome.passed ? "PASSED" : "FAILED"}`
      : arrived
        ? "DESTINATION REACHED"
        : "RUN ENDED";
    const facts = check
      ? [...check.facts(m), `${m.collisions} contacts`, violations]
      : [
          `${Math.round(snap.distance)} m in ${Math.round(snap.t)} s`,
          `${m.decisions} decisions`,
          `${m.collisions} contacts`,
          violations,
          selection.evaluation
            ? "evaluation mode: no safety brake"
            : m.safety_brake_pct !== undefined
              ? `safety brake ${m.safety_brake_pct}%`
              : null,
        ];
    replace(
      arrival,
      h(
        "span",
        { class: `dd-arrival-mark ${outcome.passed ? "pass" : "fail"}` },
        icon(outcome.passed ? Flag : X),
      ),
      h("span", { class: "dd-eyebrow" }, eyebrow),
      h("h1", {}, title),
      h("p", {}, facts.filter(Boolean).join(" · ")),
      h(
        "button",
        { type: "button", class: "dd-primary", onclick: () => restart() },
        icon(RotateCcw),
        "Drive again",
      ),
      h(
        "button",
        {
          type: "button",
          class: "dd-secondary",
          onclick: () => restart({ seed: Math.floor(Math.random() * 999_999) }),
        },
        "New seed",
        icon(Zap),
      ),
      h(
        "button",
        { type: "button", class: "dd-subtle", onclick: () => exit() },
        "Back to the lobby",
      ),
    );
    arrival.hidden = false;
  }

  function animate(now: number): void {
    frame = requestAnimationFrame(animate);
    const elapsed = now - lastNow;
    lastNow = now;
    if (probe.frames.length > 5000) probe.frames.splice(0, 1000);
    probe.frames.push(elapsed);
    const dt = Math.min(elapsed / 1000, 0.2);
    if (document.hidden || loading || !view || !scene) return;
    // The newest snapshot tells whether the run ends within the buffer.
    headOutcome = view.headOutcome;
    if (!finished) schedule(now);
    view.advance(dt, mode, lastHeadFinished());
    while (roadEvents[0] && roadEvents[0].t <= view.now) {
      const event = roadEvents.shift() as RoadEvent;
      if (event.kind === "candidates") scene.vectors.setCandidates(event.plan);
      else {
        scene.vectors.setAnswer(event.selection, event.plan, event.t);
        shown = {
          selection: event.selection,
          state: event.state,
          roundTrip: event.roundTrip,
        };
      }
    }
    if (!finished && view.current.outcome.finished && view.buffered <= 0)
      showOutcome();
    if (routeVersion !== view.current.routeVersion) {
      routeVersion = view.current.routeVersion;
      scene.vectors.clear();
      scene.moveDestination(last(view.player.route.points));
    }
    scene.render(dt);
    if (probe.poses.length > 10_000) probe.poses.splice(0, 2000);
    probe.poses.push(view.player.x, view.player.z);
    minimap.update(now);
    inspector.render();
    uiTime += dt;
    if (uiTime > 0.2) {
      uiTime = 0;
      updateHud();
    }
  }

  const keys = new AbortController();
  window.addEventListener(
    "keydown",
    (event) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, select, textarea") ||
        inspector.dialog.open ||
        event.repeat
      )
        return;
      if (event.code === "KeyC") changeCamera();
      if (event.code === "KeyP" || event.code === "KeyJ") togglePause();
      if (event.code === "KeyT") setMode(mode === "turn" ? "realtime" : "turn");
    },
    { signal: keys.signal },
  );
  document.addEventListener("fullscreenchange", onFullscreen, {
    signal: keys.signal,
  });
  document.addEventListener(
    "visibilitychange",
    () => {
      // Real-time play does not run behind a hidden tab.
      if (document.hidden && mode === "realtime" && !paused)
        pause("Paused while the tab was hidden.");
    },
    { signal: keys.signal },
  );
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.debugOpen !== previous.debugOpen) {
      debugButton.setAttribute("aria-pressed", String(state.debugOpen));
      stage.classList.toggle("with-debug", state.debugOpen);
    }
  });
  stage.classList.toggle("with-debug", store.get().debugOpen);

  syncPilot();
  frame = requestAnimationFrame(animate);
  void start();

  return () => {
    generation++;
    cancelAnimationFrame(frame);
    keys.abort();
    unsubscribe();
    clearTimeout(toastTimer);
    sim?.terminate();
    minimap.dispose();
    scene?.dispose();
    document.body.classList.remove("dd-driving");
    root.replaceChildren();
  };
}
