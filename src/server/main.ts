// The dev and local server: the UI through Bun's HTML imports, the API
// under /api. Bound to the loopback address only.

import index from "../ui/index.html";
import { createApp } from "./app.ts";
import { ConfigStore, configHome } from "./config.ts";

const DEFAULT_PORT = 7000;
/** Bun's own cap; each route enforces a smaller one. */
const MAX_BODY = 1024 * 1024;

const env = process.env;
const store = new ConfigStore(configHome(env), env);
const app = createApp({ store });
const port = Number(env.DECISION_DUNGEONS_PORT ?? DEFAULT_PORT);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  maxRequestBodySize: MAX_BODY,
  development: env.NODE_ENV !== "production",
  routes: {
    "/": index,
    "/play": index,
    "/config": index,
    "/api/*": (req, srv) => app.fetch(req, srv.port ?? port),
  },
  fetch: () => new Response("Not found", { status: 404 }),
});

console.log(`Decision Dungeons on ${server.url} (config in ${store.home})`);
