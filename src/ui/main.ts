// The browser entry: one store, four routes (the gate, a dungeon's lobby,
// config, play), and the debug sidebar beside them. Browser code: web APIs
// only.

import type { ConfigPatch } from "../contract/api.ts";
import { dungeonById } from "../dungeons/registry.ts";
import { ApiError, api } from "./api.ts";
import { defaultAutopilot } from "./autopilot.ts";
import { configPage } from "./config-page.ts";
import { debugSidebar } from "./debug.ts";
import { replace } from "./dom.ts";
import { focusGate, gatePage, orderedDungeons } from "./gate.ts";
import { lobbyPage } from "./lobby.ts";
import { Player, playView } from "./play.ts";
import { type Selection, type State, Store } from "./store.ts";

type Route = State["route"];

interface Place {
  route: Route;
  /** The dungeon a lobby URL names, when it names a registered one. */
  dungeon?: string;
}

/** `/`, `/d/<dungeon>`, `/config`, `/play`; anything else is the gate. */
function locate(path: string): Place {
  if (path === "/config") return { route: "config" };
  if (path === "/play") return { route: "play" };
  const lobby = /^\/d\/([^/]+)\/?$/.exec(path);
  const id = lobby?.[1] ? decodeURIComponent(lobby[1]) : undefined;
  if (id && dungeonById(id)) return { route: "lobby", dungeon: id };
  return { route: "gate" };
}

function pathOf(route: Route, dungeon: string): string {
  if (route === "lobby") return `/d/${encodeURIComponent(dungeon)}`;
  if (route === "gate") return "/";
  return `/${route}`;
}

/** The selection for entering a dungeon: its first level, the autopilot kept. */
function enterSelection(current: Selection, dungeon: string): Selection {
  if (current.dungeon === dungeon) return current;
  return {
    ...current,
    dungeon,
    level: dungeonById(dungeon)?.levels[0]?.id ?? "",
  };
}

const initial = locate(location.pathname);
const first = orderedDungeons()[0];
const store = new Store({
  route: initial.route,
  selection: enterSelection(
    {
      dungeon: first?.id ?? "",
      level: first?.levels[0]?.id ?? "",
      decider: "rule",
      model: "baseline",
      seed: 1,
    },
    initial.dungeon ?? first?.id ?? "",
  ),
  debugOpen: false,
  debug: [],
});

function navigate(route: Route, dungeon = store.get().selection.dungeon): void {
  const path = pathOf(route, dungeon);
  if (location.pathname !== path) history.pushState(null, "", path);
  const { selection } = store.get();
  store.set({ route, selection: enterSelection(selection, dungeon) });
}

const home = () => navigate("gate");
const config = () => navigate("config");
const player = new Player(store, () => navigate("lobby"));

const message = (error: unknown) =>
  error instanceof ApiError ? error.message : "The server is not answering.";

/** Points the selection at the dungeon's saved autopilot, or the first usable one. */
function applyDefaultAutopilot(): void {
  const { deciders, config, selection } = store.get();
  if (!deciders) return;
  const choice = defaultAutopilot(
    deciders,
    config?.autopilot[selection.dungeon],
  );
  if (choice) store.set({ selection: { ...selection, ...choice } });
}

async function load(): Promise<void> {
  const [deciders, config] = await Promise.allSettled([
    api.deciders(),
    api.config(),
  ]);
  store.set({
    ...(deciders.status === "fulfilled"
      ? { deciders: deciders.value, decidersError: undefined }
      : { decidersError: message(deciders.reason) }),
    ...(config.status === "fulfilled"
      ? { config: config.value, configError: undefined }
      : { configError: message(config.reason) }),
  });
}

async function save(patch: ConfigPatch): Promise<void> {
  const config = await api.updateConfig(patch);
  store.set({ config });
  // The deciders' status depends on the config (binary, key).
  store.set({ deciders: await api.deciders() });
}

const app = document.getElementById("app");
if (!app) throw new Error("index.html has no #app");
document.body.append(debugSidebar(store));

function render(): void {
  const state = store.get();
  if (!app) return;
  if (state.route === "play" && !state.play) {
    navigate("lobby");
    return;
  }
  document.body.dataset.route = state.route;
  if (state.route === "gate") {
    replace(
      app,
      gatePage(store, {
        enter: (dungeon) => navigate("lobby", dungeon),
        home,
        config,
      }),
    );
    focusGate(app);
  } else if (state.route === "lobby")
    replace(
      app,
      lobbyPage(store, {
        play: () => {
          player.start(store.get().selection);
          navigate("play");
        },
        home,
        config,
      }),
    );
  else if (state.route === "config")
    replace(app, configPage(store, { save, home }));
  else replace(app, playView(store, player));
  window.scrollTo(0, 0);
}

store.subscribe((state, previous) => {
  if (state.selection.dungeon !== previous.selection.dungeon)
    applyDefaultAutopilot();
  const changed = (keys: (keyof State)[]) =>
    keys.some((key) => state[key] !== previous[key]);
  if (
    changed(["route"]) ||
    (state.route === "gate" && changed(["deciders", "decidersError"])) ||
    (state.route === "lobby" &&
      changed(["deciders", "decidersError", "config", "selection"])) ||
    (state.route === "config" &&
      changed(["deciders", "config", "configError", "configNotice"])) ||
    (state.route === "play" && changed(["play", "debugOpen"]))
  )
    render();
});

window.addEventListener("popstate", () => {
  const { route, dungeon } = locate(location.pathname);
  if (route !== "play") player.stop();
  const { selection } = store.get();
  store.set({
    route,
    selection: dungeon ? enterSelection(selection, dungeon) : selection,
  });
});

window.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, select, textarea")) return;
  if (event.key === "n" || event.key === "N")
    store.set({ debugOpen: !store.get().debugOpen });
});

render();
await load();
applyDefaultAutopilot();
