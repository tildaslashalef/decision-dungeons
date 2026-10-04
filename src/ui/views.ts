// Each dungeon's browser view, by dungeon id. The run is opaque outside its
// dungeon; this table pairs each run with the view written for its type.

import type { BugfixRun } from "../dungeons/bugfix/bugfix.ts";
import { bugfixView } from "../dungeons/bugfix/view.ts";
import type { CrossingRun } from "../dungeons/crossing/crossing.ts";
import { crossingView } from "../dungeons/crossing/view.ts";
import {
  mountDrivingStage,
  type StageContext,
} from "../dungeons/driving/ui/stage.ts";
import type { EvensongRun } from "../dungeons/evensong/evensong.ts";
import { evensongView } from "../dungeons/evensong/view.ts";
import { oracleView } from "../dungeons/oracle/view.ts";
import type { TextRun } from "../dungeons/text/text-dungeon.ts";
import { textView } from "../dungeons/text/view.ts";
import { mountTowerStage } from "../dungeons/tower/ui/stage.ts";
import type { UndercroftRun } from "../dungeons/undercroft/undercroft.ts";
import { undercroftView } from "../dungeons/undercroft/view.ts";
import { h } from "./dom.ts";
import type { PlayStatus } from "./store.ts";

/**
 * Reading cases back: the case shown (absent: the view's own choice, the
 * one being asked or just answered) and how to choose another (absent:
 * the run is deciding, so cases cannot be chosen).
 */
export interface Browse {
  focus?: number;
  select?: ((index: number) => void) | undefined;
}

type View = (run: unknown, status: PlayStatus, browse: Browse) => HTMLElement;

const views: Record<string, View> = {
  crossing: (run, status, b) => crossingView(run as CrossingRun, status, b),
  inbox: (run, status, b) => textView("email", run as TextRun, status, b),
  tickets: (run, status, b) => textView("ticket", run as TextRun, status, b),
  logs: (run, status, b) => textView("logs", run as TextRun, status, b),
  receipts: (run, status, b) => textView("receipt", run as TextRun, status, b),
  review: (run, status, b) => textView("code", run as TextRun, status, b),
  bugfix: (run, status, b) => bugfixView(run as BugfixRun, status, b),
  oracle: (run, status, b) => oracleView(run as TextRun, status, b),
  undercroft: (run, status) => undercroftView(run as UndercroftRun, status),
  evensong: (run, status, b) => evensongView(run as EvensongRun, status, b),
};

/** Dungeons whose view can show any answered case again. */
const BROWSABLE = new Set([
  "crossing",
  "inbox",
  "tickets",
  "logs",
  "receipts",
  "review",
  "bugfix",
  "oracle",
  "evensong",
]);
export const browsable = (id: string): boolean => BROWSABLE.has(id);

/** Pause between turns in the card view, ms: long enough to read each answer. */
const PACE_MS: Record<string, number> = { undercroft: 280, evensong: 900 };
export const dungeonPace = (id: string): number => PACE_MS[id] ?? 700;

/**
 * A dungeon that owns the whole play screen (its own loop, HUD, and
 * rendering) instead of a card in the shared play view. Returns its unmount.
 */
export type Stage = (root: HTMLElement, ctx: StageContext) => () => void;

const stages: Record<string, Stage> = {
  driving: mountDrivingStage,
  tower: mountTowerStage,
};

export function dungeonStage(id: string): Stage | undefined {
  return Object.hasOwn(stages, id) ? stages[id] : undefined;
}

export function dungeonView(
  id: string,
  run: unknown,
  status: PlayStatus,
  browse: Browse = {},
): HTMLElement {
  return views[id]?.(run, status, browse) ?? h("p", {}, `No view for ${id}.`);
}
