// The browser entry: one store, three routes (start, config, play), and the
// debug sidebar beside them. Browser code: web APIs only.

import type { ConfigPatch } from "../contract/api.ts";
import { dungeonById, dungeons } from "../dungeons/registry.ts";
import { ApiError, api } from "./api.ts";
import { defaultAutopilot } from "./autopilot.ts";
import { configPage } from "./config-page.ts";
import { debugSidebar } from "./debug.ts";
import { replace } from "./dom.ts";
import { Player, playView } from "./play.ts";
import { startScreen } from "./start.ts";
import { type State, Store } from "./store.ts";

type Route = State["route"];

const PATHS: Record<Route, string> = {
  start: "/",
  config: "/config",
  play: "/play",
};

function routeOf(path: string): Route {
  if (path === PATHS.config) return "config";
  if (path === PATHS.play) return "play";
  return "start";
}

const first = Object.values(dungeons)[0];
const store = new Store({
  route: routeOf(location.pathname),
  selection: {
    dungeon: first?.id ?? "",
    level: first?.levels[0]?.id ?? "",
    decider: "rule",
    model: "baseline",
    seed: 1,
  },
  debugOpen: false,
  debug: [],
});

function navigate(route: Route): void {
  if (location.pathname !== PATHS[route])
    history.pushState(null, "", PATHS[route]);
  store.set({ route });
}

const player = new Player(store, () => navigate("start"));

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
    navigate("start");
    return;
  }
  document.body.dataset.route = state.route;
  if (state.route === "start")
    replace(
      app,
      startScreen(store, {
        play: () => {
          player.start(store.get().selection);
          navigate("play");
        },
        navigate,
      }),
    );
  else if (state.route === "config")
    replace(app, configPage(store, { save, navigate }));
  else replace(app, playView(store, player));
}

store.subscribe((state, previous) => {
  if (state.selection.dungeon !== previous.selection.dungeon)
    applyDefaultAutopilot();
  const changed = (keys: (keyof State)[]) =>
    keys.some((key) => state[key] !== previous[key]);
  if (
    changed(["route"]) ||
    (state.route === "start" &&
      changed(["deciders", "decidersError", "config", "selection"])) ||
    (state.route === "config" &&
      changed(["deciders", "config", "configError", "configNotice"])) ||
    (state.route === "play" && changed(["play", "debugOpen"]))
  )
    render();
});

window.addEventListener("popstate", () => {
  const route = routeOf(location.pathname);
  if (route !== "play") player.stop();
  store.set({ route });
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
if (!dungeonById(store.get().selection.dungeon)) navigate("start");
