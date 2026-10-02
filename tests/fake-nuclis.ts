// A fake nuclis API: a `fetch` that answers the routes of nuclis's
// docs/reference/api.md with canned bodies and records what it was sent.
// No server, model, GPU, or network.

export const FAKE_NUCLIS_URL = "http://nuclis.test/v1";

export interface FakeCall {
  method: string;
  /** The path and query after the base URL, e.g. `/decisions?explain=1`. */
  path: string;
  body: unknown;
}

/** A route's answer: a JSON body (status 200), or a status and body, or a thrown error. */
export type FakeReply =
  | { status: number; body: unknown }
  | { throws: unknown }
  | { json: unknown };

export interface FakeRoutes {
  health?: () => FakeReply;
  models?: () => FakeReply;
  decisions?: (body: unknown) => FakeReply;
}

export interface FakeNuclis {
  fetch: typeof fetch;
  calls: FakeCall[];
}

export const ok = (json: unknown): FakeReply => ({ json });

export const healthBody = {
  status: "ok",
  version: "0.4.0-test",
  backend: "metal",
  loaded: ["laya"],
  queue: { queued: 0, running: false, completed: 3 },
  decisions: { waiting: 0, batches: 2, requests: 2 },
  connections: 1,
};

export function fakeNuclis(routes: FakeRoutes = {}): FakeNuclis {
  const calls: FakeCall[] = [];
  const reply = async (r: FakeReply): Promise<Response> => {
    if ("throws" in r) throw r.throws;
    if ("json" in r) return Response.json(r.json);
    return Response.json(r.body, { status: r.status });
  };
  const notFound = (): FakeReply => ({
    status: 404,
    body: { error: { code: "not_found", message: "no route" } },
  });
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(FAKE_NUCLIS_URL))
      throw new Error(`the fake nuclis was asked for ${url}`);
    init?.signal?.throwIfAborted();
    const path = url.slice(FAKE_NUCLIS_URL.length);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path === "/health")
      return reply((routes.health ?? (() => ok(healthBody)))());
    if (path === "/models") return reply((routes.models ?? notFound)());
    if (path.startsWith("/decisions"))
      return reply(routes.decisions ? routes.decisions(body) : notFound());
    return reply(notFound());
  }) as typeof fetch;
  return { fetch: fake, calls };
}

/** What `POST /v1/decisions?explain=1` answers for one choice question named motion. */
export function decideOutput(choice = "stop") {
  return {
    schema_version: 1,
    model: "laya",
    repo: "convaiinnovations/laya",
    revision: "55cf4c4e",
    timings_ms: { load: 70.4, tokenize: 0.1, encode: 76.7 },
    results: [
      {
        answers: {
          motion: {
            type: "choice",
            choice,
            probabilities:
              choice === "stop"
                ? { drive: 0.4016, stop: 0.5984 }
                : { drive: 0.5984, stop: 0.4016 },
            confidence: 0.0281,
            nuclis: {
              answer_confidence: 0.5984,
              logits: [-0.38, 0.37],
              temperature: 1.9,
              bucket: "choice:2",
              sequence_tokens: 44,
              state_kept: 18,
            },
          },
        },
        usage: { input_tokens: 44, output_tokens: 0 },
        nuclis: { state: "state[0]", state_tokens: 18, truncated: false },
      },
    ],
  };
}

const model = (id: string, kind: string, present: boolean) => ({
  id,
  object: "model",
  created: 0,
  owned_by: "convaiinnovations",
  nuclis: {
    kind,
    present,
    loaded: false,
    default: id === "laya",
    max_len: present ? 512 : null,
    head_max_len: present ? 192 : null,
    repo: `convaiinnovations/${id}`,
    revision: null,
  },
});

/** `GET /v1/models`, with a language model and an unpulled decision model mixed in. */
export const modelListing = {
  object: "list",
  data: [
    model("qwen3.8-27b", "generation", true),
    model("laya", "decision", true),
    model("laya-multilingual", "decision", true),
    model("clef-flash", "decision", false),
  ],
};
