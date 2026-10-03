// Scoring forecasts against outcomes and against the truth: every number a
// run of The Oracle reports, from (probability, outcome, true chance)
// triples. Pure: the dungeon, its view, and the CLI share it.

import type { CalibrationBin } from "../dungeon.ts";

export interface Forecast {
  /** The decider's probability. */
  p: number;
  outcome: boolean;
  /** The true chance the outcome was drawn from. */
  truth: number;
}

/** Bins of the reliability diagram: five, each 0.2 wide; the last includes 1. */
export const BIN_EDGES = [0, 0.2, 0.4, 0.6, 0.8, 1] as const;

/**
 * Log loss clamps probabilities to this distance from 0 and 1: deciders
 * round to four places, so a certain 0 or 1 is a rounding, not infinity.
 */
export const LOG_LOSS_EPS = 1e-4;

const mean = (values: number[]) =>
  values.reduce((n, v) => n + v, 0) / values.length;

export function binOf(p: number): number {
  return Math.min(BIN_EDGES.length - 2, Math.floor(p / 0.2));
}

/** The reliability diagram's bins, empty bins left out. */
export function calibration(forecasts: Forecast[]): CalibrationBin[] {
  const bins: CalibrationBin[] = [];
  for (let b = 0; b < BIN_EDGES.length - 1; b++) {
    const inBin = forecasts.filter((f) => binOf(f.p) === b);
    if (!inBin.length) continue;
    bins.push({
      from: BIN_EDGES[b] as number,
      to: BIN_EDGES[b + 1] as number,
      n: inBin.length,
      forecast: mean(inBin.map((f) => f.p)),
      observed: mean(inBin.map((f) => (f.outcome ? 1 : 0))),
      truth: mean(inBin.map((f) => f.truth)),
    });
  }
  return bins;
}

/**
 * The run's scores: `truth_gap` (mean |p − true p|), Brier against the
 * outcomes and the oracle's Brier (the true chances' own, the floor no
 * forecaster beats in expectation), skill against the run's base rate,
 * and log loss. Skill is left out when every outcome was the same (the
 * base rate's Brier is 0); everything is left out with no forecasts.
 */
export function forecastMetrics(forecasts: Forecast[]): Record<string, number> {
  if (!forecasts.length) return {};
  const o = (f: Forecast) => (f.outcome ? 1 : 0);
  const brier = mean(forecasts.map((f) => (f.p - o(f)) ** 2));
  const rate = mean(forecasts.map(o));
  const climate = rate * (1 - rate);
  const clamp = (p: number) =>
    Math.min(1 - LOG_LOSS_EPS, Math.max(LOG_LOSS_EPS, p));
  return {
    truth_gap: mean(forecasts.map((f) => Math.abs(f.p - f.truth))),
    brier,
    oracle_brier: mean(forecasts.map((f) => (f.truth - o(f)) ** 2)),
    ...(climate > 0 ? { skill: 1 - brier / climate } : {}),
    log_loss: mean(
      forecasts.map((f) =>
        f.outcome ? -Math.log(clamp(f.p)) : -Math.log(1 - clamp(f.p)),
      ),
    ),
  };
}

/** Bins from many runs pooled into one diagram, weighted by their counts. */
export function poolCalibration(runs: CalibrationBin[][]): CalibrationBin[] {
  const sums = new Map<
    number,
    { to: number; n: number; f: number; o: number; t: number; tn: number }
  >();
  for (const bin of runs.flat()) {
    const s = sums.get(bin.from) ?? {
      to: bin.to,
      n: 0,
      f: 0,
      o: 0,
      t: 0,
      tn: 0,
    };
    s.n += bin.n;
    s.f += bin.forecast * bin.n;
    s.o += bin.observed * bin.n;
    if (bin.truth !== undefined) {
      s.t += bin.truth * bin.n;
      s.tn += bin.n;
    }
    sums.set(bin.from, s);
  }
  return [...sums.entries()]
    .sort(([a], [b]) => a - b)
    .map(([from, s]) => ({
      from,
      to: s.to,
      n: s.n,
      forecast: s.f / s.n,
      observed: s.o / s.n,
      ...(s.tn ? { truth: s.t / s.tn } : {}),
    }));
}
