// Routes from wherever the car is: join a nearby street, then reach the
// original destination approach, with genuinely different alternatives
// after a long departure from the planned route.

import {
  angle,
  blockedByBuilding,
  dist,
  last,
  nearestOnPath,
  type Point,
  type Pose,
  pointAt,
} from "./geometry.ts";
import { shortestPath } from "./grid.ts";
import type { Building, Junction, Route, World } from "./types.ts";
import { makeRoute } from "./world.ts";

export interface RouteChoice {
  route: Route;
  /** The car's station on the new route. */
  progress: number;
  distance: number;
  relativeHeading: number;
  score: number;
}

/** Dijkstra that may not pass through `avoid`. */
function pathAvoiding(
  world: World,
  start: string,
  end: string,
  avoid: string,
): string[] | null {
  const costs = new Map<string, number>([[start, 0]]);
  const previous = new Map<string, string>();
  const pending = new Set(
    world.nodes
      .map((n) => n.id)
      .filter((id) => id !== avoid || id === start || id === end),
  );
  const cost = (id: string) => costs.get(id) ?? Number.POSITIVE_INFINITY;
  while (pending.size) {
    const id = [...pending].reduce((a, b) => (cost(a) < cost(b) ? a : b));
    if (!Number.isFinite(cost(id))) return null;
    if (id === end) {
      const path = [end];
      while (path[0] !== start)
        path.unshift(previous.get(path[0] as string) as string);
      return path;
    }
    pending.delete(id);
    const from = world.byId[id] as Junction;
    for (const next of from.neighbors) {
      if (!pending.has(next)) continue;
      const c = cost(id) + dist(from, world.byId[next] as Junction);
      if (c < cost(next)) {
        costs.set(next, c);
        previous.set(next, id);
      }
    }
  }
  return null;
}

/** Candidate routes from the car's position, best first. */
export function routesFromLocation(
  world: World,
  car: Pose,
  destinationApproach: string[],
  destinationPoint: Point | null,
): RouteChoice[] {
  const [approach, destination] = destinationApproach as [string, string];
  const buildings = world.objects.filter(
    (o): o is Building => o.type === "building",
  );
  const edges = world.edges
    .map((edge) => {
      const a = world.byId[edge.a] as Junction;
      const b = world.byId[edge.b] as Junction;
      const near = nearestOnPath(
        car,
        edge.path ?? [
          { ...a, s: 0 },
          { ...b, s: dist(a, b) },
        ],
      );
      return { edge, distance: near.distance };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 6);
  const candidates: RouteChoice[] = [];
  const seen = new Set<string>();
  for (const { edge } of edges) {
    const directions: [string, string][] = edge.oneWay
      ? [[edge.a, edge.b]]
      : [
          [edge.a, edge.b],
          [edge.b, edge.a],
        ];
    for (const [a, b] of directions) {
      let initial: string[];
      try {
        initial =
          a === approach && b === destination
            ? [a, b]
            : [a, ...shortestPath(world, b, approach), destination];
      } catch {
        continue; // A one-way ramp cannot take the car back against traffic.
      }
      const paths = [initial];
      if (b !== destination && b !== approach) {
        for (const exit of (world.byId[b] as Junction).neighbors.filter(
          (id) => id !== a,
        )) {
          const onward = pathAvoiding(world, exit, approach, b);
          if (onward) paths.push([a, b, ...onward, destination]);
        }
      }
      for (const ids of paths) {
        if (seen.has(ids.join(","))) continue;
        seen.add(ids.join(","));
        const route = makeRoute(world, ids);
        const entryEnd = (route.crossings[0]?.stopS ?? Number.NaN) + 17;
        const entry = Number.isFinite(entryEnd)
          ? route.points.filter((p) => p.s <= entryEnd)
          : route.points;
        if (entry.length < 2) continue;
        const near = nearestOnPath(car, entry);
        const relativeHeading = angle(near.heading - car.heading);
        const score =
          near.distance * 5 +
          Math.abs(relativeHeading) * 9 +
          (route.length - near.s) * 0.025 +
          (blockedByBuilding(car, near, buildings) ? 80 : 0);
        const start = Math.max(0, near.s - 3);
        route.points = [
          pointAt(route.points, start),
          ...route.points.filter((p) => p.s > start),
        ].map((p) => ({ ...p, s: p.s - start }));
        route.crossings = route.crossings
          .filter((c) => c.stopS >= start - 19)
          .map((c) => ({ ...c, stopS: c.stopS - start }));
        route.length -= start;
        if (route.sections)
          route.sections = route.sections
            .filter((section) => section.endS > start)
            .map((section) => ({
              ...section,
              startS: Math.max(0, section.startS - start),
              endS: section.endS - start,
            }));
        if (
          destinationPoint &&
          dist(last(route.points), destinationPoint) > 0.01
        ) {
          route.length += dist(last(route.points), destinationPoint);
          route.points.push({ ...destinationPoint, s: route.length });
        }
        candidates.push({
          route,
          progress: near.s - start,
          distance: near.distance,
          relativeHeading,
          score,
        });
      }
    }
  }
  return candidates.sort((a, b) => a.score - b.score);
}

export function routeFromLocation(
  world: World,
  car: Pose,
  destinationApproach: string[],
  destinationPoint: Point | null,
): RouteChoice | null {
  return (
    routesFromLocation(world, car, destinationApproach, destinationPoint)[0] ??
    null
  );
}
