// Building a world by type, and the route helpers every layer shares.

import { nearestOnPath, type Point } from "./geometry.ts";
import { generateGrid, gridRoute } from "./grid.ts";
import { generateHighway, highwayRoute } from "./highway.ts";
import type { Route, Section, World, WorldType } from "./types.ts";

export const WORLD_TYPES: WorldType[] = ["town", "city", "highway"];

export function generateWorld(seed: number, type: WorldType = "town"): World {
  return type === "highway" ? generateHighway(seed) : generateGrid(seed, type);
}

/** A route through junction ids; `laneOffset` picks a highway lane (9 m is the right lane). */
export function makeRoute(
  world: World,
  ids: string[],
  laneOffset?: number,
): Route {
  return world.type === "highway"
    ? highwayRoute(world, ids, laneOffset)
    : gridRoute(world, ids);
}

/** Anything that drives a route: a car with its position along it. */
export interface OnRoute extends Point {
  route: Route;
}

/** The section of a highway route at station `progress` (nearest to the car by default). */
export function routeSection(
  car: OnRoute,
  progress: number | null = null,
): Section | null {
  const sections = car.route.sections;
  if (!sections?.length) return null;
  const s = progress ?? nearestOnPath(car, car.route.points).s;
  return (
    sections.find((section) => section.endS > s) ??
    (sections[sections.length - 1] as Section)
  );
}
