import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decider } from "../src/contract/decider.ts";
import {
  createDeciders,
  type DeciderSettings,
} from "../src/deciders/registry.ts";
import { crossing } from "../src/dungeons/crossing/crossing.ts";
import { createApp, MAX_IN_FLIGHT } from "../src/server/app.ts";
import { CaseStore } from "../src/server/cases.ts";
import { ConfigStore, configHome } from "../src/server/config.ts";
import {
  decideOutput,
  FAKE_NUCLIS_URL,
  fakeNuclis,
  modelListing,
  ok,
} from "./fake-nuclis.ts";

const fake = fakeNuclis({
  models: () => ok(modelListing),
  decisions: () => ok(decideOutput("stop")),
});
const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dd-home-"));
  homes.push(home);
  return home;
}

let seen: DeciderSettings[] = [];
let slow: Promise<void> | undefined;

function start(env: Record<string, string> = {}) {
  const store = new ConfigStore(newHome(), {
    NUCLIS_URL: FAKE_NUCLIS_URL,
    ...env,
  });
  const app = createApp({
    store,
    cases: new CaseStore(store.home),
    deciders: (settings) => {
      seen.push(settings);
      const deciders = createDeciders({ ...settings, fetch: fake.fetch });
      if (!slow) return deciders;
      const gate = slow;
      const random: Decider = {
        ...deciders.random,
        decide: async (req, opts) => {
          await gate;
          return deciders.random.decide(req, opts);
        },
      };
      return { ...deciders, random };
    },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req, srv) => app.fetch(req, srv.port ?? 0),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, init);
  const send = (method: string, path: string, body: unknown, headers = {}) =>
    call(path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { store, server, base, call, send };
}

const request = crossing.observe(crossing.create(1, "mixed")).request;

beforeEach(() => {
  seen = [];
  slow = undefined;
});

describe("config", () => {
  test("is written with mode 600 and the key never comes back", async () => {
    const { store, send, call, server } = start();
    const put = await send("PUT", "/api/config", {
      typesafe: { apiKey: "sk-test-123456" },
      autopilot: {
        crossing: { decider: "nuclis", model: "laya-multilingual" },
      },
    });
    expect(put.status).toBe(200);
    const text = await put.text();
    expect(text).not.toContain("sk-test-123456");
    expect(JSON.parse(text)).toMatchObject({
      typesafe: { keySet: true, keySource: "file" },
      nuclis: { url: FAKE_NUCLIS_URL, urlSource: "env" },
      autopilot: {
        crossing: { decider: "nuclis", model: "laya-multilingual" },
      },
    });
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(store.file, "utf8")).typesafe.apiKey).toBe(
      "sk-test-123456",
    );
    const get = await (await call("/api/config")).text();
    expect(get).not.toContain("sk-test-123456");
    await send("PUT", "/api/config", { typesafe: { apiKey: null } });
    expect(await (await call("/api/config")).json()).toMatchObject({
      typesafe: { keySet: false },
    });
    server.stop(true);
  });

  test("environment variables override the file", async () => {
    const { send, call, server } = start({ TYPESAFE_API_KEY: "sk-from-env-1" });
    await send("PUT", "/api/config", {
      typesafe: { apiKey: "sk-from-file-1" },
    });
    expect(await (await call("/api/config")).json()).toMatchObject({
      typesafe: { keySet: true, keySource: "env" },
    });
    await call("/api/deciders");
    expect(seen.at(-1)?.typesafeKey).toBe("sk-from-env-1");
    server.stop(true);
  });

  test("the nuclis URL defaults, saves, and ignores the old binary settings", async () => {
    const store = new ConfigStore(newHome(), {});
    writeFileSync(
      store.file,
      JSON.stringify({ nuclis: { bin: "/opt/nuclis", backend: "cpu" } }),
    );
    expect(store.publicView(await store.load()).nuclis).toEqual({
      url: "http://127.0.0.1:8000/v1",
      urlSource: "default",
    });
    const saved = await store.update({
      nuclis: { url: "http://127.0.0.1:9000/v1" },
    });
    expect(store.effective(saved).nuclisUrl).toBe("http://127.0.0.1:9000/v1");
    expect(JSON.parse(readFileSync(store.file, "utf8")).nuclis).toEqual({
      url: "http://127.0.0.1:9000/v1",
    });
    expect(() =>
      new ConfigStore(store.home, { NUCLIS_URL: "nuclis" }).effective(saved),
    ).toThrow("NUCLIS_URL must be an http(s) URL");
  });

  test("a nuclis URL without a path is saved with /v1", async () => {
    const { send, store, server } = start();
    const res = await send("PUT", "/api/config", {
      nuclis: { url: "http://127.0.0.1:8000" },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(store.file, "utf8")).nuclis.url).toBe(
      "http://127.0.0.1:8000/v1",
    );
    server.stop(true);
  });

  test("bad patches are refused with a reason", async () => {
    const { send, server } = start();
    for (const body of [
      { nuclis: { url: "ftp://127.0.0.1:8000/v1" } },
      { nuclis: { url: "http://user:pw@127.0.0.1:8000/v1" } },
      { nuclis: { url: "not a url" } },
      { nuclis: { bin: "/usr/local/bin/nuclis" } },
      { typesafe: { apiKey: "has space in it" } },
      { autopilot: { nowhere: { decider: "rule", model: "baseline" } } },
      { autopilot: { crossing: { decider: "oracle", model: "x" } } },
      { colour: "blue" },
    ]) {
      const res = await send("PUT", "/api/config", body);
      expect(res.status).toBe(400);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("bad_request");
    }
    server.stop(true);
  });

  test("the config home must be absolute", () => {
    expect(() => configHome({ DECISION_DUNGEONS_HOME: "relative" })).toThrow(
      "absolute",
    );
    expect(configHome({ DECISION_DUNGEONS_HOME: "/tmp/x" })).toBe("/tmp/x");
  });

  test("a corrupt config file is a config error, not a crash", async () => {
    const { store, call, server } = start();
    writeFileSync(store.file, "{not json");
    const res = await call("/api/config");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "config_error" } });
    server.stop(true);
  });
});

describe("deciders", () => {
  test("lists all four with their status and models", async () => {
    const { call, server } = start();
    const { deciders } = (await (await call("/api/deciders")).json()) as {
      deciders: {
        id: string;
        status: { configured: boolean };
        models: { id: string }[];
      }[];
    };
    expect(deciders.map((d) => d.id)).toEqual([
      "nuclis",
      "typesafe",
      "rule",
      "random",
    ]);
    const byId = Object.fromEntries(deciders.map((d) => [d.id, d]));
    expect(byId.nuclis?.models.map((m) => m.id)).toEqual([
      "laya",
      "laya-multilingual",
      "clef-flash",
      "laya-next",
    ]);
    expect(byId.typesafe?.status.configured).toBe(false);
    expect(byId.rule?.models.map((m) => m.id)).toEqual(["baseline"]);
    server.stop(true);
  });
});

describe("case sets", () => {
  test("lists and sends a text dungeon's sets, written on first use", async () => {
    const { call, server } = start();
    const listed = (await (await call("/api/cases/logs")).json()) as {
      sets: { name: string; count: number }[];
      base: string;
    };
    expect(listed.base).toBe("base");
    expect(listed.sets.map((s) => s.name)).toEqual(["base"]);
    const set = (await (
      await call("/api/cases/logs/base?level=thresholds")
    ).json()) as { cases: { level: string }[]; hash: string };
    expect(set.cases.length).toBe(100);
    expect(set.cases.every((c) => c.level === "thresholds")).toBe(true);
    expect((await call("/api/cases/logs/nothing")).status).toBe(404);
    expect((await call("/api/cases/crossing")).status).toBe(404);
    expect((await call("/api/cases/logs/..%2Fetc")).status).toBe(400);
    server.stop(true);
  });
});

describe("decide", () => {
  test("each decider answers through the same endpoint", async () => {
    const { send, server } = start();
    for (const [decider, model] of [
      ["nuclis", "laya"],
      ["rule", "baseline"],
      ["random", "uniform"],
    ]) {
      const res = await send("POST", "/api/decide", {
        dungeon: "crossing",
        decider,
        model,
        request,
        seed: 3,
      });
      expect(res.status).toBe(200);
      const decision = (await res.json()) as {
        decider: string;
        answers: object;
      };
      expect(decision.decider).toBe(decider as string);
      expect(Object.keys(decision.answers)).toEqual(["motion"]);
    }
    server.stop(true);
  });

  test("failures are typed", async () => {
    const { send, server } = start();
    const decide = async (body: object) => {
      const res = await send("POST", "/api/decide", {
        dungeon: "crossing",
        decider: "random",
        model: "uniform",
        request,
        ...body,
      });
      return {
        status: res.status,
        body: (await res.json()) as { error: { code: string } },
      };
    };
    expect(
      await decide({ decider: "typesafe", model: "jev-latest" }),
    ).toMatchObject({
      status: 503,
      body: { error: { code: "unconfigured" } },
    });
    expect(await decide({ dungeon: "nowhere" })).toMatchObject({ status: 400 });
    expect(await decide({ decider: "oracle" })).toMatchObject({ status: 400 });
    expect(
      await decide({
        request: {
          state: 1,
          questions: { q: { type: "x", instructions: "" } },
        },
      }),
    ).toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });
    server.stop(true);
  });

  test("bodies are bounded and at most three decisions run at once", async () => {
    const { send, server } = start();
    const big = await send("POST", "/api/decide", {
      dungeon: "crossing",
      decider: "random",
      model: "uniform",
      request: { ...request, state: "x".repeat(300_000) },
    });
    expect(big.status).toBe(413);

    let release = () => {};
    slow = new Promise((resolve) => {
      release = resolve;
    });
    const body = {
      dungeon: "crossing",
      decider: "random",
      model: "uniform",
      request,
    };
    const running = Array.from({ length: MAX_IN_FLIGHT }, () =>
      send("POST", "/api/decide", body),
    );
    await Bun.sleep(50);
    const refused = await send("POST", "/api/decide", body);
    expect(refused.status).toBe(429);
    release();
    for (const res of await Promise.all(running)) expect(res.status).toBe(200);
    server.stop(true);
  });
});

describe("local only", () => {
  test("refuses foreign Host headers, cross-origin writes, and non-JSON writes", async () => {
    const { send, call, server, base } = start();
    const rebound = await call("/api/config", {
      headers: { Host: `evil.example:${server.port}` },
    });
    expect(rebound.status).toBe(403);
    const crossOrigin = await send(
      "PUT",
      "/api/config",
      { nuclis: { url: "http://evil.example/v1" } },
      { Origin: "http://evil.example" },
    );
    expect(crossOrigin.status).toBe(403);
    const form = await call("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ nuclis: { url: "http://evil.example/v1" } }),
    });
    expect(form.status).toBe(415);
    const sameOrigin = await send(
      "PUT",
      "/api/config",
      { nuclis: { url: "http://127.0.0.1:8001/v1" } },
      { Origin: base },
    );
    expect(sameOrigin.status).toBe(200);
    server.stop(true);
  });
});
