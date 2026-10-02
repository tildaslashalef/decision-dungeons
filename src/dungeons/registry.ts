// Every dungeon, by id. Pure: the server, the CLI, and the browser import it.

import { crossing } from "./crossing/crossing.ts";
import type { AnyDungeon } from "./dungeon.ts";

export const dungeons: Record<string, AnyDungeon> = {
  [crossing.id]: crossing,
};

export function dungeonById(id: string): AnyDungeon | undefined {
  return Object.hasOwn(dungeons, id) ? dungeons[id] : undefined;
}
