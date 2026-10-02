// The play view and its loop: one turn at a time through /api/decide,
// paced so a person can follow it. Simulated time does not run while the
// autopilot decides, so a slow decider plays the same game as a fast one.

import { ArrowLeft, Bug, Pause, Play, RotateCcw } from "lucide";
import type { Outcome } from "../dungeons/dungeon.ts";
import { dungeonById } from "../dungeons/registry.ts";
import { playTurn } from "../dungeons/turn.ts";
import { ApiError, api } from "./api.ts";
import { h, icon } from "./dom.ts";
import {
  DEBUG_HISTORY,
  type DebugEntry,
  type PlayState,
  type Selection,
  type Store,
} from "./store.ts";
import { dungeonStage, dungeonView } from "./views.ts";

/** Pause between turns, so each answer stays on screen long enough to read. */
const PACE_MS = 700;

const clock = () => new Date().toLocaleTimeString([], { hour12: false });

export class Player {
  private token = 0;
  private controller?: AbortController;
  private nextId = 1;

  constructor(
    private readonly store: Store,
    private readonly onExit: () => void,
  ) {}

  start(selection: Selection): void {
    const dungeon = dungeonById(selection.dungeon);
    if (!dungeon) return;
    this.stop();
    if (dungeonStage(dungeon.id)) {
      // A full-screen stage creates and runs its own run.
      this.store.set({
        debug: [],
        play: {
          selection,
          run: null,
          outcome: { finished: false, violations: 0, metrics: {}, records: [] },
          status: "waiting",
        },
      });
      return;
    }
    this.nextId = 1;
    const token = this.token;
    const begin = (run: unknown) => {
      if (token !== this.token) return;
      this.patch({ run, outcome: dungeon.outcome(run), status: "waiting" });
      void this.loop(token);
    };
    const fresh = {
      finished: false,
      violations: 0,
      metrics: {},
      records: [],
    };
    if (!dungeon.caseSets) {
      const run = dungeon.create(selection.seed, selection.level, {
        evaluation: selection.evaluation,
      });
      this.store.set({
        debug: [],
        play: { selection, run, outcome: fresh, status: "waiting" },
      });
      begin(run);
      return;
    }
    // A text dungeon's cases come from the server's case set first.
    this.store.set({
      debug: [],
      play: { selection, run: null, outcome: fresh, status: "loading" },
    });
    // A level that plays another level's cases needs that level's.
    const pool =
      dungeon.levels.find((l) => l.id === selection.level)?.casesOf ??
      selection.level;
    api
      .caseSet(selection.dungeon, selection.caseSet, pool)
      .then((cases) =>
        begin(
          dungeon.create(selection.seed, selection.level, {
            evaluation: selection.evaluation,
            cases,
          }),
        ),
      )
      .catch((error: unknown) => {
        if (token !== this.token) return;
        this.patch({
          status: "failed",
          error: {
            code: error instanceof ApiError ? error.code : "unavailable",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
  }

  pause(): void {
    this.patch({ status: "paused" });
  }

  resume(): void {
    const play = this.store.get().play;
    if (!play || play.status === "finished") return;
    if (play.run === null) {
      this.start(play.selection);
      return;
    }
    this.token++;
    this.patch({ status: "waiting" });
    void this.loop(this.token);
  }

  restart(): void {
    const play = this.store.get().play;
    if (play) this.start(play.selection);
  }

  stop(): void {
    this.token++;
    this.controller?.abort();
  }

  exit(): void {
    this.stop();
    this.store.set({ play: undefined });
    this.onExit();
  }

  private patch(patch: Partial<PlayState>): void {
    const play = this.store.get().play;
    if (play) this.store.set({ play: { ...play, ...patch } });
  }

  private record(entry: DebugEntry): void {
    const rest = this.store.get().debug.filter((e) => e.id !== entry.id);
    this.store.set({ debug: [entry, ...rest].slice(0, DEBUG_HISTORY) });
  }

  private async loop(token: number): Promise<void> {
    const live = () => token === this.token;
    while (live()) {
      const play = this.store.get().play;
      if (!play || play.status === "paused" || play.run === null) return;
      const dungeon = dungeonById(play.selection.dungeon);
      if (!dungeon) return;
      if (dungeon.outcome(play.run).finished) {
        this.patch({ status: "finished" });
        return;
      }
      const { selection } = play;
      this.controller = new AbortController();
      const signal = this.controller.signal;
      let outcome: Outcome;
      try {
        const turn = await playTurn(dungeon, play.run, async (request) => {
          const entry: DebugEntry = {
            id: this.nextId++,
            time: clock(),
            request,
          };
          this.record(entry);
          this.patch({ status: "deciding", current: entry });
          const started = performance.now();
          try {
            const decision = await api.decide(
              {
                dungeon: selection.dungeon,
                decider: selection.decider,
                model: selection.model,
                request,
                seed: selection.seed,
              },
              signal,
            );
            const done = {
              ...entry,
              decision,
              roundTripMs: performance.now() - started,
            };
            if (live()) {
              this.record(done);
              this.patch({ current: done });
            }
            return decision;
          } catch (error) {
            if (live() && error instanceof ApiError)
              this.record({
                ...entry,
                error: { code: error.code, message: error.message },
              });
            throw error;
          }
        });
        outcome = turn.outcome;
      } catch (error) {
        if (!live()) return;
        this.patch({
          status: "failed",
          error:
            error instanceof ApiError
              ? { code: error.code, message: error.message }
              : { code: "unavailable", message: String(error) },
        });
        return;
      }
      if (!live()) return;
      this.patch({
        outcome,
        status: outcome.finished ? "finished" : "waiting",
      });
      if (outcome.finished) return;
      await sleep(PACE_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function outcomeLine(outcome: Outcome): string {
  const m = outcome.metrics;
  const parts: string[] = [];
  if (m.decided !== undefined)
    parts.push(
      m.cases !== undefined
        ? `${m.decided} of ${m.cases} decided`
        : `${m.decided} decided`,
    );
  if (m.correct !== undefined) parts.push(`${m.correct} correct`);
  parts.push(
    `${outcome.violations} violation${outcome.violations === 1 ? "" : "s"}`,
  );
  return parts.join(" · ");
}

export function playView(store: Store, player: Player): HTMLElement {
  const { play, debugOpen } = store.get();
  if (!play) return h("main", { class: "page" });
  const dungeon = dungeonById(play.selection.dungeon);
  const level = dungeon?.levels.find((l) => l.id === play.selection.level);
  const { status, outcome, selection } = play;
  const running = status === "deciding" || status === "waiting";

  const hud = h(
    "header",
    { class: "hud glass" },
    h(
      "button",
      {
        type: "button",
        "aria-label": "Exit",
        title: "Exit",
        onclick: () => player.exit(),
      },
      icon(ArrowLeft),
    ),
    h(
      "div",
      { class: "hud-title" },
      h("b", {}, dungeon?.title ?? selection.dungeon),
      h(
        "span",
        {},
        `${level?.title ?? selection.level} · seed ${selection.seed}`,
      ),
    ),
    h(
      "div",
      { class: `engaged ${status}` },
      h("i", { class: "dot" }),
      `${selection.decider} · ${selection.model} ${status === "finished" ? "finished" : status === "paused" ? "paused" : status === "failed" ? "stopped" : "engaged"}`,
    ),
    h(
      "div",
      { class: "hud-actions" },
      h(
        "button",
        {
          type: "button",
          class: debugOpen ? "active" : "",
          title: "Debug (N)",
          onclick: () => store.set({ debugOpen: !store.get().debugOpen }),
        },
        icon(Bug),
        h("span", {}, "Debug"),
        h("kbd", {}, "N"),
      ),
      status === "finished"
        ? null
        : h(
            "button",
            {
              type: "button",
              title: running ? "Pause" : "Resume",
              onclick: () => (running ? player.pause() : player.resume()),
            },
            icon(running ? Pause : Play),
            h("span", {}, running ? "Pause" : "Resume"),
          ),
      h(
        "button",
        { type: "button", title: "Restart", onclick: () => player.restart() },
        icon(RotateCcw),
        h("span", {}, "Restart"),
      ),
    ),
  );

  const stage = h(
    "div",
    { class: "stage card glass" },
    dungeon && play.run !== null
      ? dungeonView(dungeon.id, play.run, status)
      : status === "loading"
        ? h("p", { class: "loading-text" }, "Loading the cases…")
        : null,
    h(
      "div",
      { class: "outcome" },
      status === "finished"
        ? h(
            "b",
            { class: outcome.passed ? "pass" : "fail" },
            outcome.passed ? "Passed" : "Failed",
          )
        : null,
      h("span", {}, outcomeLine(outcome)),
      outcome.metrics.accuracy !== undefined
        ? h(
            "span",
            {},
            `accuracy ${Math.round(outcome.metrics.accuracy * 100)}%`,
          )
        : null,
    ),
    play.error && status === "failed"
      ? h(
          "div",
          { class: "banner error", role: "alert" },
          h("b", {}, play.error.code),
          h("span", {}, play.error.message),
          h(
            "button",
            { type: "button", onclick: () => player.resume() },
            "Retry",
          ),
        )
      : null,
  );

  return h(
    "main",
    { class: `play scene${debugOpen ? " with-debug" : ""}` },
    h("div", { class: "scene-sky", "aria-hidden": "true" }),
    h("div", { class: "scene-floor", "aria-hidden": "true" }),
    hud,
    stage,
  );
}
