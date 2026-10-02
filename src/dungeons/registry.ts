// Every dungeon, by id, in the order the gate shows them. Pure: the
// server, the CLI, and the browser import it.

import { crossing } from "./crossing/crossing.ts";
import { driving } from "./driving/driving.ts";
import type { AnyDungeon } from "./dungeon.ts";
import { inbox } from "./inbox/inbox.ts";
import { logs } from "./logs/logs.ts";
import { tickets } from "./tickets/tickets.ts";

export const dungeons: Record<string, AnyDungeon> = {
  [driving.id]: driving as AnyDungeon,
  [inbox.id]: inbox as AnyDungeon,
  [tickets.id]: tickets as AnyDungeon,
  [logs.id]: logs as AnyDungeon,
  [crossing.id]: crossing as AnyDungeon,
};

export function dungeonById(id: string): AnyDungeon | undefined {
  return Object.hasOwn(dungeons, id) ? dungeons[id] : undefined;
}
