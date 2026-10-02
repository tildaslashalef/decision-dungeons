// The HTTP API. Every route is local-only: the Host header must name the
// loopback address (no DNS rebinding), and a write must be same-origin JSON
// (no cross-site form posts), because the config names where the server
// sends decisions.

import type {
  ApiErrorBody,
  ApiErrorCode,
  DecideBody,
  DeciderView,
} from "../contract/api.ts";
import { type Decider, decideWith } from "../contract/decider.ts";
import { type DecideErrorCode, isDecideError } from "../contract/errors.ts";
import { parseRequest, RequestError } from "../contract/validate.ts";
import {
  createDeciders,
  type DeciderId,
  type DeciderSettings,
  decideTimeoutMs,
  isDeciderId,
} from "../deciders/registry.ts";
import { dungeonById } from "../dungeons/registry.ts";
import { BASE_SET, CaseError, type CaseStore } from "./cases.ts";
import { ConfigError, type ConfigStore, parsePatch } from "./config.ts";
import { log } from "./log.ts";

/** Body bounds per route, in bytes. */
/** A request with its images, under nuclis's own 4 MiB body. */
export const DECIDE_BODY_LIMIT = 4 * 1024 * 1024;
export const CONFIG_BODY_LIMIT = 16 * 1024;
/** Decisions running at once; more are refused, not queued. */
export const MAX_IN_FLIGHT = 3;

const DECIDE_STATUS: Record<DecideErrorCode, number> = {
  unconfigured: 503,
  rejected: 502,
  unavailable: 502,
  timeout: 504,
  invalid_answer: 502,
};

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** A model id; a cascade's is `screener:judge@threshold`. */
const MODEL = /^[A-Za-z0-9._:@-]{1,200}$/;

export interface AppOptions {
  store: ConfigStore;
  /** The text dungeons' case sets; the base sets are written on first use. */
  cases: CaseStore;
  /** Builds the deciders; tests replace it to inject fakes. */
  deciders?: (settings: DeciderSettings) => Record<DeciderId, Decider>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function json(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function fail(status: number, code: ApiErrorCode, message: string): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return json(status, body);
}

function loopbackHost(host: string | null, port: number): boolean {
  return (
    host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    host === `[::1]:${port}`
  );
}

/** Rejects a write that a browser could have sent from another site. */
function checkWrite(req: Request): void {
  const host = req.headers.get("host");
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== `http://${host}`)
    throw new HttpError(403, "forbidden", "cross-origin writes are refused");
  if (req.headers.get("sec-fetch-site") === "cross-site")
    throw new HttpError(403, "forbidden", "cross-site writes are refused");
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json"))
    throw new HttpError(415, "bad_request", "send application/json");
}

async function readJson(req: Request, limit: number): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > limit)
    throw new HttpError(
      413,
      "too_large",
      `bodies are limited to ${limit} bytes`,
    );
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > limit)
    throw new HttpError(
      413,
      "too_large",
      `bodies are limited to ${limit} bytes`,
    );
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "bad_request", "the body is not valid JSON");
  }
}

function decideBody(raw: unknown): DecideBody {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new HttpError(400, "bad_request", "the body must be an object");
  const body = raw as Record<string, unknown>;
  const { dungeon, decider, model, seed } = body;
  if (typeof dungeon !== "string" || !dungeonById(dungeon))
    throw new HttpError(400, "bad_request", "unknown dungeon");
  if (!isDeciderId(decider))
    throw new HttpError(400, "bad_request", "unknown decider");
  if (typeof model !== "string" || !MODEL.test(model))
    throw new HttpError(400, "bad_request", "model must be a model id");
  if (seed !== undefined && !Number.isSafeInteger(seed))
    throw new HttpError(400, "bad_request", "seed must be an integer");
  let request: DecideBody["request"];
  try {
    request = parseRequest(body.request);
  } catch (error) {
    if (error instanceof RequestError)
      throw new HttpError(400, "bad_request", error.message);
    throw error;
  }
  return {
    dungeon,
    decider,
    model,
    request,
    ...(typeof seed === "number" ? { seed } : {}),
  };
}

export function createApp(options: AppOptions) {
  const { store } = options;
  const build = options.deciders ?? createDeciders;
  let inFlight = 0;

  async function deciders(): Promise<Record<DeciderId, Decider>> {
    return build(store.effective(await store.load()));
  }

  async function listDeciders(): Promise<DeciderView[]> {
    return Promise.all(
      Object.values(await deciders()).map(async (decider) => {
        const status = await decider.status();
        const view: DeciderView = {
          id: decider.id,
          label: decider.label,
          status,
          models: [],
        };
        if (!status.configured && decider.id !== "typesafe") return view;
        try {
          view.models = await decider.models();
        } catch (error) {
          view.modelsError =
            error instanceof Error ? error.message : "could not list models";
        }
        return view;
      }),
    );
  }

  async function decide(req: Request): Promise<Response> {
    checkWrite(req);
    const body = decideBody(await readJson(req, DECIDE_BODY_LIMIT));
    if (inFlight >= MAX_IN_FLIGHT)
      throw new HttpError(
        429,
        "busy",
        `at most ${MAX_IN_FLIGHT} decisions run at once`,
      );
    inFlight++;
    try {
      const id = body.decider as DeciderId;
      const dungeon = dungeonById(body.dungeon);
      const decider =
        id === "rule" && dungeon ? dungeon.rule : (await deciders())[id];
      const signal = AbortSignal.any([
        req.signal,
        AbortSignal.timeout(
          await decideTimeoutMs(id, decider, [body.request], body.model),
        ),
      ]);
      const decision = await decideWith(decider, body.request, {
        model: body.model,
        signal,
        ...(body.seed !== undefined ? { seed: body.seed } : {}),
      });
      return json(200, decision);
    } finally {
      inFlight--;
    }
  }

  async function putConfig(req: Request): Promise<Response> {
    checkWrite(req);
    const raw = await readJson(req, CONFIG_BODY_LIMIT);
    let patch: ReturnType<typeof parsePatch>;
    try {
      patch = parsePatch(raw);
    } catch (error) {
      if (error instanceof ConfigError)
        throw new HttpError(400, "bad_request", error.message);
      throw error;
    }
    for (const [dungeon, autopilot] of Object.entries(patch.autopilot ?? {})) {
      if (!dungeonById(dungeon))
        throw new HttpError(400, "bad_request", `unknown dungeon ${dungeon}`);
      if (autopilot && !isDeciderId(autopilot.decider))
        throw new HttpError(400, "bad_request", "unknown decider");
    }
    return json(200, store.publicView(await store.update(patch)));
  }

  /** `GET /api/cases/:dungeon` lists sets; `/:dungeon/:set[?level=]` sends one. */
  async function caseSets(
    dungeon: string,
    name: string | undefined,
    level: string | undefined,
  ): Promise<Response> {
    const d = dungeonById(dungeon);
    if (!d?.caseSets)
      return fail(404, "not_found", `${dungeon} plays no case sets`);
    try {
      await options.cases.ensureBase();
    } catch (error) {
      if (!(error instanceof CaseError)) throw error;
      return fail(503, "cases_unavailable", error.message);
    }
    if (name === undefined)
      return json(200, { sets: options.cases.list(dungeon), base: BASE_SET });
    if (!NAME.test(name) || (level !== undefined && !NAME.test(level)))
      return fail(400, "bad_request", "bad set or level name");
    const set = options.cases.load(dungeon, name, level);
    if (!set) return fail(404, "not_found", `${dungeon} has no set ${name}`);
    return json(200, set);
  }

  async function route(req: Request, path: string): Promise<Response> {
    const method = req.method;
    if (path === "/api/deciders" && method === "GET")
      return json(200, { deciders: await listDeciders() });
    if (path === "/api/config" && method === "GET")
      return json(200, store.publicView(await store.load()));
    if (path === "/api/config" && method === "PUT") return putConfig(req);
    if (path === "/api/decide" && method === "POST") return decide(req);
    const cases = path.match(/^\/api\/cases\/([^/]+)(?:\/([^/]+))?$/);
    if (cases && method === "GET")
      return caseSets(
        decodeURIComponent(cases[1] ?? ""),
        cases[2] === undefined ? undefined : decodeURIComponent(cases[2]),
        new URL(req.url).searchParams.get("level") ?? undefined,
      );
    return fail(404, "not_found", `no route ${method} ${path}`);
  }

  return {
    /** Handles /api/*; anything else is a 404. `port` is the server's own. */
    async fetch(req: Request, port: number): Promise<Response> {
      const path = new URL(req.url).pathname;
      if (!loopbackHost(req.headers.get("host"), port))
        return fail(403, "forbidden", "this server answers on localhost only");
      try {
        return await route(req, path);
      } catch (error) {
        if (error instanceof HttpError)
          return fail(error.status, error.code, error.message);
        if (isDecideError(error))
          return fail(DECIDE_STATUS[error.code], error.code, error.message);
        // A stored config that no longer parses: the player must fix the file.
        if (error instanceof ConfigError)
          return fail(500, "config_error", error.message);
        if (error instanceof CaseError)
          return fail(400, "bad_request", error.message);
        log.error(`${req.method} ${path} failed`, { error });
        return fail(500, "unavailable", "the server failed; see its log");
      }
    },
  };
}
