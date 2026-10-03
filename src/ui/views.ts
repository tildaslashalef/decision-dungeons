// Each dungeon's browser view, by dungeon id. The run is opaque outside its
// dungeon; this table pairs each run with the view written for its type.

import type { CrossingRun } from "../dungeons/crossing/crossing.ts";
import { crossingView } from "../dungeons/crossing/view.ts";
import {
  mountDrivingStage,
  type StageContext,
} from "../dungeons/driving/ui/stage.ts";
import { oracleView } from "../dungeons/oracle/view.ts";
import type { TextRun } from "../dungeons/text/text-dungeon.ts";
import { textView } from "../dungeons/text/view.ts";
import { mountTowerStage } from "../dungeons/tower/ui/stage.ts";
import type { UndercroftRun } from "../dungeons/undercroft/undercroft.ts";
import { undercroftView } from "../dungeons/undercroft/view.ts";
import { h } from "./dom.ts";
import type { PlayStatus } from "./store.ts";

type View = (run: unknown, status: PlayStatus) => HTMLElement;

const views: Record<string, View> = {
  crossing: (run, status) => crossingView(run as CrossingRun, status),
  inbox: (run, status) => textView("email", run as TextRun, status),
  tickets: (run, status) => textView("ticket", run as TextRun, status),
  logs: (run, status) => textView("logs", run as TextRun, status),
  receipts: (run, status) => textView("receipt", run as TextRun, status),
  oracle: (run, status) => oracleView(run as TextRun, status),
  undercroft: (run, status) => undercroftView(run as UndercroftRun, status),
};

/** Pause between turns in the card view, ms: long enough to read each answer. */
const PACE_MS: Record<string, number> = { undercroft: 280 };
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
): HTMLElement {
  return views[id]?.(run, status) ?? h("p", {}, `No view for ${id}.`);
}
