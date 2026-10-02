// Every dungeon, by id, in the order the gate shows them. Pure: the
// server, the CLI, and the browser import it.

import { crossing } from "./crossing/crossing.ts";
import { driving } from "./driving/driving.ts";
import type { AnyDungeon } from "./dungeon.ts";

export const dungeons: Record<string, AnyDungeon> = {
  [driving.id]: driving as AnyDungeon,
  [crossing.id]: crossing as AnyDungeon,
};

export function dungeonById(id: string): AnyDungeon | undefined {
  return Object.hasOwn(dungeons, id) ? dungeons[id] : undefined;
}
