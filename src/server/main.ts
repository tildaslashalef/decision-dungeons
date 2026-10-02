// The dev and local server: the UI through Bun's HTML imports, the API
// under /api. Bound to the loopback address only.

import index from "../ui/index.html";
import { createApp } from "./app.ts";
import { serveAsset, serveWorker } from "./assets.ts";
import { CaseStore } from "./cases.ts";
import { ConfigStore, configHome } from "./config.ts";
import { iconRoutes } from "./icons.ts";
import { log } from "./log.ts";

const DEFAULT_PORT = 7000;
/** Bun's own cap; each route enforces a smaller one. */
const MAX_BODY = 1024 * 1024;

const env = process.env;
const home = configHome(env);
const store = new ConfigStore(home, env);
const app = createApp({ store, cases: new CaseStore(home) });
const port = Number(env.DECISION_DUNGEONS_PORT ?? DEFAULT_PORT);
const http = log.child("http");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  maxRequestBodySize: MAX_BODY,
  development: env.NODE_ENV !== "production",
  routes: {
    "/": index,
    "/play": index,
    "/d/*": index,
    "/config": index,
    "/api/*": async (req, srv) => {
      const started = performance.now();
      const res = await app.fetch(req, srv.port ?? port);
      const ms = Math.round(performance.now() - started);
      const line = `${req.method} ${new URL(req.url).pathname}`;
      (res.status >= 400 ? http.warn : http.info)(line, {
        status: res.status,
        ms,
      });
      return res;
    },
    ...iconRoutes,
    "/models/*": (req) => serveAsset(new URL(req.url).pathname),
    "/textures/*": (req) => serveAsset(new URL(req.url).pathname),
    "/draco/*": (req) => serveAsset(new URL(req.url).pathname),
    "/workers/:name": (req) =>
      serveWorker(req.params.name, env.NODE_ENV !== "production"),
  },
  fetch: () => new Response("Not found", { status: 404 }),
});

log.info(`Decision Dungeons on ${server.url}`, { config: store.home });
