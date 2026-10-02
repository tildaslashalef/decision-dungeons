// The cascade: a fast nuclis model screens every state, and a slow one
// decides the states the fast one is unsure of, could not read whole, or
// cannot see. Both are nuclis models; the pairs come from `GET /v1/models`
// (a model that packs screens, one that does not judges), so a new model
// joins with no code change here.
//
// A model id is `screener:judge@threshold`, so every result names the pair
// and the threshold it ran with.

import type { Answer, Decision } from "../contract/answer.ts";
import type { DecideOptions, Decider, ModelInfo } from "../contract/decider.ts";
import { DecideError } from "../contract/errors.ts";
import type { Request } from "../contract/request.ts";

/** The screener's least sure answer must reach this to stand; the lobby's pairs use it. */
export const DEFAULT_THRESHOLD = 0.85;

export interface CascadeModel {
  screener: string;
  judge: string;
  threshold: number;
}

export function cascadeId({
  screener,
  judge,
  threshold,
}: CascadeModel): string {
  return `${screener}:${judge}@${threshold}`;
}

/** Reads `screener:judge@threshold`; the threshold defaults when absent. */
export function parseCascade(id: string): CascadeModel {
  const match = /^([^:@]+):([^:@]+)(?:@([0-9.]+))?$/.exec(id);
  const threshold =
    match?.[3] === undefined ? DEFAULT_THRESHOLD : Number(match[3]);
  if (!match?.[1] || !match[2] || !(threshold > 0 && threshold <= 1))
    throw new DecideError(
      "rejected",
      `a cascade is screener:judge@threshold, the threshold in (0, 1]; got ${id}`,
    );
  return { screener: match[1], judge: match[2], threshold };
}

/** How sure an answer is: the top probability of its options. */
export function sureness(answer: Answer): number | undefined {
  if (answer.type === "noul") return Math.max(answer.noul, 1 - answer.noul);
  const ps = Object.values(answer.probabilities ?? {});
  return ps.length ? Math.max(...ps) : undefined;
}

/** The screener's least sure answer; undefined when one reports no probabilities. */
function leastSure(decision: Decision): number | undefined {
  let least = 1;
  for (const answer of Object.values(decision.answers)) {
    const p = sureness(answer);
    if (p === undefined) return undefined;
    least = Math.min(least, p);
  }
  return least;
}

/** Every screener (packs) with every judge (does not), among available models. */
export function cascadePairs(models: ModelInfo[]): ModelInfo[] {
  const ready = models.filter((m) => m.available);
  const screeners = ready.filter((m) => m.packs === true);
  const judges = ready.filter((m) => m.packs === false);
  return screeners.flatMap((s) =>
    judges.map((j) => ({
      id: cascadeId({
        screener: s.id,
        judge: j.id,
        threshold: DEFAULT_THRESHOLD,
      }),
      label: `${s.label} → ${j.label}`,
      available: true,
      // A request with images goes straight to the judge.
      ...(j.images ? { images: true } : {}),
    })),
  );
}

export function cascadeDecider(nuclis: Decider): Decider {
  const decideBatch = nuclis.decideBatch?.bind(nuclis);
  const sum = (a: number | undefined, b: number | undefined) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

  /** The decision a cascade gives: the judge's when it was asked, else the screener's. */
  function combine(
    pair: CascadeModel,
    model: string,
    screened: Decision | undefined,
    judged: Decision | undefined,
    reason: "unsure" | "truncated" | "images" | undefined,
    screenConfidence: number | undefined,
  ): Decision {
    const answered = (judged ?? screened) as Decision;
    const inputTokens = sum(
      screened?.usage?.inputTokens,
      judged?.usage?.inputTokens,
    );
    return {
      ...answered,
      decider: "cascade",
      model,
      ...(inputTokens !== undefined
        ? { usage: { inputTokens, outputTokens: 0 } }
        : {}),
      timings: {
        total: (screened?.timings.total ?? 0) + (judged?.timings.total ?? 0),
      },
      debug: {
        ...answered.debug,
        cascade: {
          screener: pair.screener,
          judge: pair.judge,
          threshold: pair.threshold,
          ...(screenConfidence !== undefined ? { screenConfidence } : {}),
          escalated: !!judged,
          ...(reason ? { reason } : {}),
        },
      },
    };
  }

  /** Why the screener's answer cannot stand, if it cannot. */
  function escalation(
    pair: CascadeModel,
    screened: Decision,
  ): { reason?: "unsure" | "truncated"; confidence?: number } {
    const confidence = leastSure(screened);
    if (screened.debug?.truncated)
      return {
        reason: "truncated",
        ...(confidence !== undefined ? { confidence } : {}),
      };
    if (confidence === undefined || confidence < pair.threshold)
      return {
        reason: "unsure",
        ...(confidence !== undefined ? { confidence } : {}),
      };
    return { confidence };
  }

  const timed = async (
    model: string,
    request: Request,
    options: DecideOptions,
  ): Promise<Decision> => {
    const started = performance.now();
    const decision = await nuclis.decide(request, { ...options, model });
    return {
      ...decision,
      timings: {
        ...decision.timings,
        total: Math.round(performance.now() - started),
      },
    };
  };

  return {
    id: "cascade",
    label: "Cascade",
    status: () => nuclis.status(),
    async models() {
      return cascadePairs(await nuclis.models());
    },
    ...(nuclis.prepare ? { prepare: nuclis.prepare.bind(nuclis) } : {}),
    async decide(request, options) {
      const pair = parseCascade(options.model);
      if (request.images)
        return combine(
          pair,
          options.model,
          undefined,
          await timed(pair.judge, request, options),
          "images",
          undefined,
        );
      const screened = await timed(pair.screener, request, options);
      const { reason, confidence } = escalation(pair, screened);
      const judged = reason
        ? await timed(pair.judge, request, options)
        : undefined;
      return combine(pair, options.model, screened, judged, reason, confidence);
    },
    // The screener sees the whole batch in one call; the judge then takes
    // the states it was unsure of, one at a time.
    batches: async () => true,
    async decideBatch(requests, options) {
      const pair = parseCascade(options.model);
      const screenable = requests.filter((r) => !r.images);
      const started = performance.now();
      const screened =
        screenable.length && decideBatch
          ? await decideBatch(screenable, { ...options, model: pair.screener })
          : [];
      const share = screenable.length
        ? Math.round((performance.now() - started) / screenable.length)
        : 0;
      const out: Decision[] = [];
      let k = 0;
      for (const request of requests) {
        if (request.images) {
          out.push(
            combine(
              pair,
              options.model,
              undefined,
              await timed(pair.judge, request, options),
              "images",
              undefined,
            ),
          );
          continue;
        }
        const s = screened[k++] as Decision;
        const first = { ...s, timings: { ...s.timings, total: share } };
        const { reason, confidence } = escalation(pair, first);
        const judged = reason
          ? await timed(pair.judge, request, options)
          : undefined;
        out.push(
          combine(pair, options.model, first, judged, reason, confidence),
        );
      }
      return out;
    },
    async timeoutMs(requests, model) {
      const pair = parseCascade(model);
      const screen = (await nuclis.timeoutMs?.(requests, pair.screener)) ?? 0;
      const judge = (await nuclis.timeoutMs?.(requests, pair.judge)) ?? 0;
      return screen + judge;
    },
  };
}
