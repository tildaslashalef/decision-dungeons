// Seeded generator of log windows from Harborline's production services:
// ten minutes of lines, healthy noise with an incident or a red herring
// written in. An incident is user-facing and still going at the window's
// end; noise recovers or never hurt anyone. The thresholds level prints
// per-minute metrics and labels each window from those exact numbers. Pure.

import { hash, pick, type Rng, seeded } from "../../lib/random.ts";
import type { TextCase } from "../text/cases.ts";
import { between, chance } from "../text/vocab.ts";

export const LOGS_GENERATOR = "logs@2";

export type Cause =
  | "database"
  | "deploy"
  | "dependency"
  | "resources"
  | "network";

export interface LogWindow {
  service: string;
  environment: "production";
  window: string;
  /** Present on the thresholds level: the paging rule the numbers are held to. */
  policy?: string;
  lines: string[];
}

/** The thresholds level's paging rule, as the request states it. */
export const ERROR_SHARE_LIMIT = 2;
export const P95_LIMIT_MS = 800;
export const THRESHOLD_POLICY = `Page if any one minute has a 5xx share above ${ERROR_SHARE_LIMIT.toFixed(1)}% (errors_5xx / requests) or a p95 latency above ${P95_LIMIT_MS} ms.`;

const SERVICES = [
  "dispatch-api",
  "rate-engine",
  "label-service",
  "tracking-ingest",
  "billing-sync",
];
const PODS = (service: string, rng: Rng) =>
  `${service}-${between(rng, 5, 9)}${pick(rng, ["c", "d", "f"])}${between(rng, 10, 99)}-${pick(rng, ["x2k1", "q8vz", "m4tn", "h7pw"])}`;

interface Line {
  t: number;
  text: string;
}

const clock = (hour: number, t: number) => {
  const s = Math.floor(t);
  const h = hour + Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

const PATHS = [
  "/v1/shipments",
  "/v1/rates",
  "/v1/labels",
  "/v1/tracking",
  "/v1/loads/search",
];

/** Healthy traffic and housekeeping across [from, to) seconds. */
function noise(
  rng: Rng,
  service: string,
  from: number,
  to: number,
  n: number,
): Line[] {
  return Array.from({ length: n }, () => {
    const t = from + rng() * (to - from);
    const kind = rng();
    const text =
      kind < 0.62
        ? `INFO  http ${pick(rng, ["GET", "GET", "POST"])} ${pick(rng, PATHS)} ${pick(rng, [200, 200, 200, 201, 204, 304])} ${between(rng, 18, 340)}ms`
        : kind < 0.72
          ? `INFO  http GET /healthz 200 ${between(rng, 1, 4)}ms`
          : kind < 0.8
            ? `WARN  http GET ${pick(rng, ["/wp-login.php", "/.env", "/admin", "/v1/shipments/unknown"])} 404 ${between(rng, 2, 9)}ms`
            : kind < 0.9
              ? `INFO  ${service} ${pick(rng, ["cache refreshed: carrier_rates (1,842 keys)", "job sync_tracking completed in 4.2s", "flushed 312 events to kafka topic tracking.v2", "rotated api key cache"])}`
              : `DEBUG ${service} ${pick(rng, ["gc pause 11ms", "pool stats active=7 idle=13 max=20", "feature flag rate_v2 evaluated: on"])}`;
    return { t, text };
  });
}

function errors(
  rng: Rng,
  from: number,
  to: number,
  n: number,
  text: () => string,
): Line[] {
  return Array.from({ length: n }, () => ({
    t: from + rng() * (to - from),
    text: text(),
  }));
}

interface Story {
  lines: Line[];
  page: boolean;
  cause?: Cause;
  why: string;
}

/** Incidents, each still going when the window ends. */
function incident(rng: Rng, service: string, start: number): Story {
  const end = 600;
  const kind = pick(rng, [
    "database",
    "deploy",
    "dependency",
    "resources",
    "network",
  ] as const);
  const pod = PODS(service, rng);
  switch (kind) {
    case "database": {
      const variant = pick(rng, ["pool", "deadlock", "failover"]);
      const lines =
        variant === "pool"
          ? errors(rng, start, end, between(rng, 7, 11), () =>
              pick(rng, [
                `ERROR ${service} timeout acquiring connection from pool primary (waited 5000ms, active=20 idle=0 max=20)`,
                `ERROR http POST /v1/shipments 503 5012ms`,
                `ERROR http GET /v1/loads/search 503 5004ms`,
              ]),
            )
          : variant === "deadlock"
            ? errors(rng, start, end, between(rng, 6, 9), () =>
                pick(rng, [
                  `ERROR ${service} pq: deadlock detected (SQLSTATE 40P01) on UPDATE shipments`,
                  `ERROR http POST /v1/labels 500 812ms`,
                ]),
              )
            : [
                {
                  t: start,
                  text: `WARN  pgbouncer server conn crashed? closing (db=orders host=pg-primary-0)`,
                },
                ...errors(rng, start + 5, end, between(rng, 6, 9), () =>
                  pick(rng, [
                    `ERROR ${service} pq: cannot execute INSERT in a read-only transaction`,
                    `ERROR http POST /v1/shipments 500 41ms`,
                  ]),
                ),
              ];
      return {
        lines,
        page: true,
        cause: "database",
        why: `the database is failing requests (${variant}) through the window's end`,
      };
    }
    case "deploy": {
      const version = `v2.${between(rng, 30, 48)}.${between(rng, 0, 6)}`;
      return {
        lines: [
          {
            t: start - 20,
            text: `INFO  argocd sync ${service}: rolled out ${version} (3/3 pods ready)`,
          },
          ...errors(rng, start, end, between(rng, 7, 10), () =>
            pick(rng, [
              `ERROR ${service} TypeError: Cannot read properties of undefined (reading 'carrierCode') at quoteRates (rates.ts:214)`,
              `ERROR http GET /v1/rates 500 23ms`,
              `ERROR http POST /v1/shipments 500 31ms`,
            ]),
          ),
        ],
        page: true,
        cause: "deploy",
        why: `500s with a new exception started right after ${version} rolled out, and continue`,
      };
    }
    case "dependency": {
      const upstream = pick(rng, [
        "carrier API swiftlane",
        "carrier API northwind",
        "geocoding provider",
        "payments provider",
      ]);
      return {
        lines: [
          ...errors(
            rng,
            start,
            start + 60,
            3,
            () =>
              `WARN  ${service} ${upstream}: 503 Service Unavailable, retrying (attempt 2/3)`,
          ),
          {
            t: start + 70,
            text: `ERROR ${service} circuit breaker OPEN for ${upstream} after 25 consecutive failures`,
          },
          ...errors(rng, start + 75, end, between(rng, 5, 8), () =>
            pick(rng, [
              `ERROR ${service} ${upstream}: request failed: circuit open`,
              `ERROR http GET /v1/rates 502 8ms`,
            ]),
          ),
        ],
        page: true,
        cause: "dependency",
        why: `${upstream} is down, the breaker is open and requests fail`,
      };
    }
    case "resources": {
      const variant = pick(rng, ["oom", "disk"]);
      const lines =
        variant === "oom"
          ? errors(rng, start, end, between(rng, 6, 9), () =>
              pick(rng, [
                `WARN  kubelet pod=${pod} reason=OOMKilled container=${service} exit_code=137 limit=512Mi`,
                `WARN  kubelet pod=${pod} reason=BackOff msg="Back-off restarting failed container ${service}"`,
                `ERROR http POST /v1/labels 503 3ms`,
              ]),
            )
          : errors(rng, start, end, between(rng, 6, 9), () =>
              pick(rng, [
                `ERROR ${service} write /var/lib/${service}/spool/batch-${between(rng, 1000, 9999)}.json: no space left on device`,
                `ERROR http POST /v1/tracking 500 6ms`,
              ]),
            );
      return {
        lines,
        page: true,
        cause: "resources",
        why:
          variant === "oom"
            ? "the pod is in an OOM crash loop and requests fail"
            : "the disk is full and writes keep failing",
      };
    }
    default: {
      const target = pick(rng, [
        "pg-primary.internal",
        "redis-cache.internal",
        "auth.internal",
      ]);
      return {
        lines: errors(rng, start, end, between(rng, 7, 10), () =>
          pick(rng, [
            `ERROR ${service} dial tcp: lookup ${target} on 10.0.0.10:53: i/o timeout`,
            `ERROR ${service} read tcp 10.4.${between(rng, 1, 9)}.${between(rng, 2, 250)}:${between(rng, 30000, 60000)}->${target}: connection reset by peer`,
            `ERROR http GET /v1/tracking 504 30001ms`,
          ]),
        ),
        page: true,
        cause: "network",
        why: `DNS and connections to ${target} keep failing`,
      };
    }
  }
}

/** Things that look alarming and are not: recovered, retried, expected, or harmless. */
function herring(rng: Rng, service: string): Story {
  const kind = pick(rng, [
    "blip",
    "retried",
    "rollout",
    "recovered",
    "scanner",
    "deprecation",
  ]);
  const t = between(rng, 60, 480);
  switch (kind) {
    case "blip":
      return {
        lines: [
          {
            t,
            text: `ERROR http POST /v1/shipments 500 ${between(rng, 40, 300)}ms`,
          },
        ],
        page: false,
        why: "a single 500 among healthy traffic",
      };
    case "retried":
      return {
        lines: [
          {
            t,
            text: `WARN  ${service} timeout acquiring connection from pool primary (waited 1000ms), retrying`,
          },
          {
            t: t + 1.2,
            text: `INFO  ${service} retry succeeded after 1 attempt`,
          },
        ],
        page: false,
        why: "a transient timeout that a retry absorbed",
      };
    case "rollout":
      return {
        lines: [
          {
            t,
            text: `INFO  argocd sync ${service}: rolling out v2.${between(rng, 30, 48)}.${between(rng, 0, 6)}`,
          },
          {
            t: t + 8,
            text: `WARN  kubelet pod=${PODS(service, rng)} reason=Unhealthy msg="Readiness probe failed: connection refused"`,
          },
          {
            t: t + 19,
            text: `INFO  kubelet pod started, readiness probe passed`,
          },
          { t: t + 40, text: `INFO  argocd sync ${service}: 3/3 pods ready` },
        ],
        page: false,
        why: "a routine rollout whose readiness probe failed once during startup",
      };
    case "recovered": {
      const start = between(rng, 40, 200);
      return {
        lines: [
          ...errors(
            rng,
            start,
            start + 50,
            5,
            () => `ERROR http GET /v1/rates 502 ${between(rng, 5, 30)}ms`,
          ),
          {
            t: start + 55,
            text: `ERROR ${service} circuit breaker OPEN for carrier API swiftlane`,
          },
          {
            t: start + 110,
            text: `INFO  ${service} circuit breaker CLOSED for carrier API swiftlane (probe succeeded)`,
          },
        ],
        page: false,
        why: "an upstream blip early in the window that recovered minutes before its end",
      };
    }
    case "scanner":
      return {
        lines: errors(
          rng,
          t,
          t + 30,
          6,
          () =>
            `WARN  http GET ${pick(rng, ["/wp-admin/setup-config.php", "/.git/config", "/phpmyadmin/", "/.env.production"])} 404 ${between(rng, 2, 6)}ms`,
        ),
        page: false,
        why: "a vulnerability scanner hitting paths that do not exist",
      };
    default:
      return {
        lines: [
          {
            t,
            text: `WARN  ${service} config key RATE_CACHE_TTL is deprecated; use rates.cache.ttl`,
          },
          {
            t: t + 90,
            text: `WARN  ${service} config key RATE_CACHE_TTL is deprecated; use rates.cache.ttl`,
          },
        ],
        page: false,
        why: "deprecation warnings, nothing failing",
      };
  }
}

function render(rng: Rng, lines: Line[]): { window: string; lines: string[] } {
  const day = between(rng, 1, 30);
  const hour = between(rng, 0, 22);
  const sorted = [...lines].sort((a, b) => a.t - b.t);
  return {
    window: `2026-09-${String(day).padStart(2, "0")} ${clock(hour, 0)}–${clock(hour, 600)} UTC`,
    lines: sorted.map((l) => `${clock(hour, l.t)} ${l.text}`),
  };
}

/** Per-minute metrics, one breaching or none, often close to the limits. */
function thresholds(
  rng: Rng,
  service: string,
): { input: LogWindow; breach: boolean; why: string } {
  const day = between(rng, 1, 30);
  const hour = between(rng, 0, 22);
  const target = pick(rng, ["errors", "latency", "none", "none"] as const);
  const breachMinute = between(rng, 2, 9);
  const minutes = Array.from({ length: 10 }, (_, m) => {
    const requests = between(rng, 600, 2400);
    // Healthy minutes stay under the limits, some of them just under.
    let share = (rng() < 0.3 ? 1.5 + rng() * 0.45 : rng() * 1.2) / 100;
    let p95 = rng() < 0.3 ? between(rng, 700, 790) : between(rng, 180, 650);
    if (m === breachMinute && target === "errors")
      share = (2.05 + rng() * 1.2) / 100;
    if (m === breachMinute && target === "latency")
      p95 = between(rng, 805, 1100);
    const errors = Math.round(requests * share);
    const p50 = Math.round(p95 * (0.25 + rng() * 0.15));
    return { m, requests, errors, p50, p95 };
  });
  // The label comes from the numbers printed, not from the target.
  const over = minutes.filter(
    (x) =>
      (x.errors / x.requests) * 100 > ERROR_SHARE_LIMIT || x.p95 > P95_LIMIT_MS,
  );
  const lines = minutes.map(
    (x) =>
      `${clock(hour, x.m * 60)} METRIC ${service} requests=${x.requests} errors_5xx=${x.errors} p50_ms=${x.p50} p95_ms=${x.p95}`,
  );
  const worst = over[0];
  return {
    input: {
      service,
      environment: "production",
      window: `2026-09-${String(day).padStart(2, "0")} ${clock(hour, 0)}–${clock(hour, 600)} UTC`,
      policy: THRESHOLD_POLICY,
      lines,
    },
    breach: over.length > 0,
    why: worst
      ? `minute ${clock(hour, worst.m * 60)}: ${((worst.errors / worst.requests) * 100).toFixed(2)}% 5xx, p95 ${worst.p95} ms`
      : "every minute is under both limits",
  };
}

export const LOGS_TRUTH: Record<string, ("page" | "breach" | "cause")[]> = {
  incident: ["page"],
  thresholds: ["breach"],
  "root-cause": ["cause"],
  long: ["page"],
  "all-questions": ["page", "cause"],
};

export function logCases(
  level: string,
  count: number,
  seed: number,
): TextCase[] {
  const rng = seeded(hash(`logs:${level}`, seed));
  return Array.from({ length: count }, (_, index) => {
    const service = pick(rng, SERVICES);
    let input: LogWindow;
    let truth: TextCase["truth"];
    let why: string;
    if (level === "thresholds") {
      const t = thresholds(rng, service);
      input = t.input;
      truth = { breach: t.breach };
      why = t.why;
    } else {
      const long = level === "long";
      const page = level === "root-cause" ? true : index % 2 === 0;
      // An incident starts late in a long window, anywhere in a short one.
      const start = long ? between(rng, 520, 560) : between(rng, 200, 420);
      const story = page
        ? incident(rng, service, start)
        : herring(rng, service);
      // Root-cause windows also carry a red herring now and then.
      const extra =
        level === "root-cause" && chance(rng, 0.4)
          ? herring(rng, service).lines
          : [];
      const lines = [
        ...noise(
          rng,
          service,
          0,
          600,
          long ? between(rng, 300, 380) : between(rng, 14, 22),
        ),
        ...story.lines,
        ...extra,
      ];
      const rendered = render(rng, lines);
      input = {
        service,
        environment: "production",
        window: rendered.window,
        lines: rendered.lines,
      };
      truth =
        level === "root-cause"
          ? { cause: story.cause as Cause }
          : level === "all-questions"
            ? {
                page: story.page,
                cause: story.page ? (story.cause as Cause) : "none",
              }
            : { page: story.page };
      why = story.why;
    }
    return {
      id: `${level}-${String(index + 1).padStart(4, "0")}`,
      level,
      lang: "en",
      input: input as unknown as TextCase["input"],
      truth,
      why,
    };
  });
}
