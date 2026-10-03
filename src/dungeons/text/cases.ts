// Text cases: what the text dungeons play. A case is an input (an email,
// a ticket, a window of logs) and the answer each question should get,
// known because the generator built the case to have it. Cases live in
// named, immutable case sets (SQLite on the server, src/server/cases.ts);
// a run picks its cases from one set by seed. Pure: the browser imports it.

import type { JsonValue } from "../../contract/request.ts";
import { hash, type Rng, seeded } from "../../lib/random.ts";

/** A question's known answer: a noul's truth, a choice's option, a score's level. */
export type Truth = boolean | string | number;

/** The page a case's picture is rendered from, written by the seeded generator. */
export interface CaseSource {
  html: string;
  /** The page's width in CSS pixels; its height is the content's. */
  width: number;
}

export interface TextCase {
  /** Unique within its set, stable across reseeding with the same arguments. */
  id: string;
  level: string;
  /** BCP 47 language of the text, e.g. "en", "es". */
  lang: string;
  input: JsonValue;
  truth: Record<string, Truth>;
  /**
   * The true probability of each yes-or-no question, where the generator
   * knows it: the chance the outcome in `truth` was drawn from.
   */
  odds?: Record<string, number>;
  /** Why the truth is what it is, for a person reading the result. */
  why: string;
  /**
   * The case's picture as a page. The set's hash covers it, not the image,
   * so a set reproduces exactly whatever renders it.
   */
  source?: CaseSource;
  /** `source` rendered, as PNG data URLs; a stored case with a source has them. */
  images?: string[];
}

export interface CaseSetInfo {
  dungeon: string;
  name: string;
  /** The generator and its version that wrote the set. */
  generator: string;
  seed: number;
  count: number;
  /** A digest of every case's content; a run records it. */
  hash: string;
  /** Cases per level. */
  levels: Record<string, number>;
}

export interface CaseSet extends CaseSetInfo {
  cases: TextCase[];
}

/** The set a run played, as every result records it. */
export interface CaseSetRef {
  name: string;
  hash: string;
}

/**
 * `count` cases of `level` from `set`, drawn by `seed` without
 * replacement: the same set, level, and seed always give the same cases in
 * the same order.
 */
export function pickCases(
  set: CaseSet,
  level: string,
  seed: number,
  count: number,
): TextCase[] {
  const pool = set.cases
    .filter((c) => c.level === level)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rng: Rng = seeded(hash(`${set.dungeon}:${level}`, seed));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j] as TextCase, pool[i] as TextCase];
  }
  return pool.slice(0, count);
}
