// Interstate 08: start in Millbrook, take the on-ramp, merge, cruise, and
// exit into Cedar Town. One smoothed interstate centerline; every route
// along it follows the same samples, so traffic stays in its lane.

import { pick, seeded } from "../../../lib/random.ts";
import {
  at,
  dist,
  heading,
  last,
  move,
  nearestOnPath,
  type PathPoint,
  type Point,
  pointAt,
  samplePolyline,
} from "./geometry.ts";
import { THEMES } from "./grid.ts";
import type {
  Building,
  ConnectorRoad,
  Crossing,
  Junction,
  Road,
  RoadKind,
  Route,
  Section,
  World,
  WorldObject,
} from "./types.ts";

/** A Catmull-Rom spline through the nodes, resampled every 2 m. */
function smoothRoad(nodes: Point[]): PathPoint[] {
  const raw: Point[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const p0 = at(nodes, Math.max(0, i - 1));
    const p1 = at(nodes, i);
    const p2 = at(nodes, i + 1);
    const p3 = at(nodes, Math.min(nodes.length - 1, i + 2));
    for (let k = 0; k < 40; k++) {
      const t = k / 40;
      const axis = (a: "x" | "z") =>
        0.5 *
        (2 * p1[a] +
          (-p0[a] + p2[a]) * t +
          (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t * t +
          (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t * t * t);
      raw.push({ x: axis("x"), z: axis("z") });
    }
  }
  raw.push(last(nodes));
  return samplePolyline(raw, 2);
}

function offsetPath(points: Point[], offset: number): Point[] {
  return points.map((p, i) =>
    move(
      p,
      heading(
        at(points, Math.max(0, i - 1)),
        at(points, Math.min(points.length - 1, i + 1)),
      ) +
        Math.PI / 2,
      offset,
    ),
  );
}

function cubic(a: Point, b: Point, c: Point, d: Point): PathPoint[] {
  return samplePolyline(
    Array.from({ length: 81 }, (_, i) => {
      const t = i / 80;
      const u = 1 - t;
      return {
        x:
          u ** 3 * a.x +
          3 * u ** 2 * t * b.x +
          3 * u * t ** 2 * c.x +
          t ** 3 * d.x,
        z:
          u ** 3 * a.z +
          3 * u ** 2 * t * b.z +
          3 * u * t ** 2 * c.z +
          t ** 3 * d.z,
      };
    }),
    1.5,
  );
}

/**
 * A route through highway-map junctions. Interstate stretches are cut from
 * the shared centerline (re-smoothing a subset would move the lane); town
 * corners are joined with a curve through the intersection.
 */
export function highwayRoute(
  world: World,
  ids: string[],
  laneOffset = 9,
): Route {
  const points: PathPoint[] = [];
  const sections: Section[] = [];
  const crossings: Omit<Crossing, "stopS">[] = [];
  const samples = world.roadSamples as PathPoint[];
  const append = (path: Point[]) => {
    for (const p of path) {
      const end = points[points.length - 1];
      if (end && dist(end, p) < 0.001) continue;
      points.push({ x: p.x, z: p.z, s: end ? end.s + dist(end, p) : 0 });
    }
  };
  for (let i = 0; i < ids.length - 1; i++) {
    const a = ids[i] as string;
    const b = ids[i + 1] as string;
    const edge = world.edges.find(
      (e) => (e.a === a && e.b === b) || (!e.oneWay && e.b === a && e.a === b),
    );
    if (!edge) throw new Error(`No drivable connection from ${a} to ${b}`);
    let path: PathPoint[] | Point[];
    if (edge.path)
      path =
        edge.a === a
          ? edge.path
          : samplePolyline(
              offsetPath(
                [...(edge.centerline as PathPoint[])].reverse(),
                edge.laneOffset as number,
              ),
              1.5,
            );
    else {
      const start = nearestOnPath(world.byId[a] as Junction, samples).s;
      const end = nearestOnPath(world.byId[b] as Junction, samples).s;
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      const center: Point[] = [
        pointAt(samples, low),
        ...samples.filter((p) => p.s > low && p.s < high),
        pointAt(samples, high),
      ];
      if (end < start) center.reverse();
      path = offsetPath(center, laneOffset);
    }
    const junction = world.byId[a] as Junction;
    let corner: PathPoint[] | null = null;
    if (
      i > 0 &&
      (junction.townJunction ||
        (edge.kind === "local" &&
          sections[sections.length - 1]?.kind === "local"))
    ) {
      const approach = heading(at(points, points.length - 2), last(points));
      const exit = heading(at(path, 0), at(path, 1));
      if (junction.townJunction)
        crossings.push({
          nodeId: a,
          x: junction.x,
          z: junction.z,
          approach,
          exit,
        });
      if (Math.abs(Math.sin(exit - approach)) > 0.1) {
        // Join the right-hand lane to the outgoing road through the
        // intersection rather than splicing two lane ends at a sharp angle.
        const rightTurn = Math.sin(exit - approach) > 0;
        const inset = rightTurn ? 11 : 14;
        const entry = pointAt(points, last(points).s - inset);
        const leaving = pointAt(path as PathPoint[], inset);
        while (last(points).s > entry.s) points.pop();
        append([entry]);
        last(sections).endS = last(points).s;
        const bend =
          Math.abs(Math.sin(approach)) > 0.5
            ? { x: leaving.x, z: entry.z }
            : { x: entry.x, z: leaving.z };
        corner = cubic(
          entry,
          rightTurn
            ? { x: (entry.x + 2 * bend.x) / 3, z: (entry.z + 2 * bend.z) / 3 }
            : move(entry, approach, 9),
          rightTurn
            ? {
                x: (leaving.x + 2 * bend.x) / 3,
                z: (leaving.z + 2 * bend.z) / 3,
              }
            : move(leaving, exit, -9),
          leaving,
        );
        path = (path as PathPoint[]).filter((p) => p.s > inset);
      }
    }
    const startS = points[points.length - 1]?.s ?? 0;
    if (corner) append(corner);
    append(path);
    const previous = sections[sections.length - 1];
    if (
      previous &&
      previous.kind === edge.kind &&
      previous.speedLimit === edge.speedLimit
    )
      previous.endS = last(points).s;
    else
      sections.push({
        kind: edge.kind as RoadKind,
        name: edge.name,
        startS,
        endS: last(points).s,
        speedLimit: edge.speedLimit,
        laneHalfWidth: edge.kind === "interstate" ? 2.25 : 3,
      });
  }
  const withStops: Crossing[] = crossings.map((crossing) => {
    const line = move(
      move(crossing, crossing.approach, -10.5),
      crossing.approach + Math.PI / 2,
      3,
    );
    return { ...crossing, stopS: nearestOnPath(line, points).s };
  });
  return {
    ids,
    points,
    sections,
    crossings: withStops,
    length: last(points).s,
  };
}

const TOWN_COLORS = ["#eadbc9", "#d4d9cb", "#c6b4a2", "#ddd4c0"];

export function generateHighway(seed: number): World {
  const random = seeded(seed);
  const theme = THEMES.highway;
  const nodes: Junction[] = [];
  const edges: Road[] = [];
  const objects: WorldObject[] = [];
  const phase = random() * 2;
  for (let i = 0; i < 9; i++)
    nodes.push({
      id: `h${i}`,
      x: Math.sin(i * 0.65 + phase) * 48,
      z: 680 - i * 170,
      control: "none",
      offset: 0,
      neighbors: [],
    });
  const roadSamples = smoothRoad(nodes);
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = at(nodes, i);
    const b = at(nodes, i + 1);
    a.neighbors.push(b.id);
    b.neighbors.push(a.id);
    edges.push({
      id: `interstate-${i}`,
      a: a.id,
      b: b.id,
      width: 25,
      length: dist(a, b),
      speedLimit: 28,
      kind: "interstate",
      name: "Interstate 08",
    });
  }
  const byId: Record<string, Junction> = Object.fromEntries(
    nodes.map((n) => [n.id, n]),
  );
  const get = (id: string) => byId[id] as Junction;
  const station = (id: string) => nearestOnPath(get(id), roadSamples).s;
  const lanePoint = (s: number, offset: number) => {
    const p = pointAt(roadSamples, s);
    return move(p, (p.heading as number) + Math.PI / 2, offset);
  };
  const startX = Math.max(get("h0").x, get("h1").x, get("h2").x) + 145;
  const townX = Math.max(get("h6").x, get("h7").x, get("h8").x) + 155;
  const addNode = (id: string, p: Point): Junction => {
    const node: Junction = {
      id,
      x: p.x,
      z: p.z,
      control: "none",
      offset: 0,
      neighbors: [],
    };
    nodes.push(node);
    byId[id] = node;
    return node;
  };
  const start = addNode("local-start", { x: startX, z: 660 });
  const market = addNode("mill-market", { x: startX, z: 600 });
  const rampJunction = addNode("mill-interchange", { x: startX, z: 520 });
  const ramp = addNode("onramp", { x: startX - 38, z: 520 });
  const north = addNode("mill-north", { x: startX, z: 450 });
  const south = addNode("mill-south", { x: startX, z: 710 });
  const eastSouth = addNode("oak-south", { x: startX + 80, z: 710 });
  const eastMarket = addNode("oak-market", { x: startX + 80, z: 600 });
  const eastRamp = addNode("oak-interchange", { x: startX + 80, z: 520 });
  const eastNorth = addNode("oak-north", { x: startX + 80, z: 450 });
  const marketWest = addNode("market-west", { x: startX - 65, z: 600 });
  const marketEast = addNode("market-east", { x: startX + 116, z: 600 });
  for (const junction of [market, rampJunction, eastMarket, eastRamp]) {
    junction.townJunction = true;
    junction.control = "stop";
  }
  const mergeStart = station("h2");
  const mergeEnd = station("h3");
  const merge = addNode("merge-lane", lanePoint(mergeStart, 15));
  const exitStart = station("h6");
  const exitSplit = exitStart + 80;
  const exit = addNode("exit-cedar", lanePoint(exitSplit, 17));
  const town = addNode("cedar-town", { x: townX, z: -580 });
  const destination = addNode("cedar-stop", { x: townX, z: -755 });
  const connectorRoads: ConnectorRoad[] = [];
  const link = (
    a: Junction,
    b: Junction,
    surface: Point[],
    width: number,
    speed: number,
    kind: RoadKind,
    name: string,
    offset = 0,
    endInset = 0,
    twoWay = false,
  ) => {
    const sampled = samplePolyline(surface, 1.5);
    const path = samplePolyline(offsetPath(sampled, offset), 1.5);
    if (endInset) {
      const end = last(path).s - endInset;
      const stop = pointAt(path, end);
      while (last(path).s > end) path.pop();
      path.push(stop);
    }
    a.neighbors.push(b.id);
    if (twoWay) b.neighbors.push(a.id);
    edges.push({
      id: `${a.id}-${b.id}`,
      a: a.id,
      b: b.id,
      oneWay: !twoWay,
      width,
      speedLimit: speed,
      kind,
      name,
      length: last(path).s,
      path,
      ...(twoWay ? { centerline: sampled, laneOffset: offset } : {}),
    });
    connectorRoads.push({
      id: `${a.id}-${b.id}`,
      // Overlap asphalt at joins: independently sampled end tangents would
      // leave a thin wedge that rejects every forward path as off-road.
      // Rendering and occupancy share these points; the route does not.
      points: samplePolyline(
        [
          move(at(sampled, 0), heading(at(sampled, 0), at(sampled, 1)), -0.25),
          ...sampled,
          move(
            last(sampled),
            heading(at(sampled, sampled.length - 2), last(sampled)),
            0.25,
          ),
        ],
        1.5,
      ),
      width,
      kind,
      twoWay: offset !== 0,
    });
  };
  const street = (a: Junction, b: Junction, name: string) =>
    link(a, b, [a, b], 12, 10, "local", name, 3, 0, true);
  for (const [a, b] of [
    [south, start],
    [start, market],
    [market, rampJunction],
    [rampJunction, north],
  ] as const)
    street(a, b, "Millbrook · Main Street");
  for (const [a, b] of [
    [eastSouth, eastMarket],
    [eastMarket, eastRamp],
    [eastRamp, eastNorth],
  ] as const)
    street(a, b, "Millbrook · Oak Street");
  street(marketWest, market, "Millbrook · Market Street");
  street(market, eastMarket, "Millbrook · Market Street");
  street(eastMarket, marketEast, "Millbrook · Market Street");
  street(rampJunction, eastRamp, "Millbrook · Depot Street");
  street(north, eastNorth, "Millbrook · North Street");
  street(south, eastSouth, "Millbrook · South Street");
  link(
    rampJunction,
    ramp,
    [rampJunction, ramp],
    8,
    8,
    "ramp_turn",
    "Interstate 08 North entrance",
  );
  const mergeHeading = pointAt(roadSamples, mergeStart).heading as number;
  link(
    ramp,
    merge,
    cubic(
      ramp,
      move(ramp, -Math.PI / 2, 65),
      move(merge, mergeHeading, -85),
      merge,
    ),
    6,
    26,
    "onramp",
    "Interstate 08 on-ramp",
  );
  const merging = Array.from({ length: 101 }, (_, i) => {
    const t = i / 100;
    const blend = t * t * (3 - 2 * t);
    return lanePoint(mergeStart + (mergeEnd - mergeStart) * t, 15 - 6 * blend);
  });
  link(merge, get("h3"), merging, 6, 26, "merge", "Merge onto Interstate 08");
  const exiting = Array.from({ length: 61 }, (_, i) => {
    const t = i / 60;
    const blend = t * t * (3 - 2 * t);
    return lanePoint(exitStart + (exitSplit - exitStart) * t, 9 + 8 * blend);
  });
  link(get("h6"), exit, exiting, 6, 22, "exit", "Cedar Town exit");
  const townEntry = { x: town.x + 3, z: town.z };
  const exitHeading = pointAt(roadSamples, exitSplit).heading as number;
  link(
    exit,
    town,
    cubic(
      exit,
      move(exit, exitHeading, 80),
      move(townEntry, 0, -80),
      townEntry,
    ),
    6,
    16,
    "offramp",
    "Cedar Town off-ramp",
  );
  link(
    town,
    destination,
    [town, destination],
    12,
    10,
    "town",
    "Cedar Town · Station Street",
    3,
    15,
  );

  // A few side streets and low buildings make the destination a town.
  for (const z of [-620, -695])
    connectorRoads.push({
      id: `cedar-cross-${z}`,
      kind: "town",
      twoWay: true,
      width: 12,
      points: samplePolyline(
        [
          { x: townX - 55, z },
          { x: townX + 80, z },
        ],
        2,
      ),
    });
  const houses: [number, number, Building["style"]][] = [
    [townX - 22, -594, "shop"],
    [townX + 24, -594, "shop"],
    [townX - 22, -649, "cottage"],
    [townX + 24, -649, "townhouse"],
    [townX - 23, -672, "modern"],
    [townX + 25, -672, "cottage"],
    [townX - 23, -724, "shop"],
    [townX + 25, -728, "townhouse"],
    [startX - 23, 676, "cottage"],
    [startX - 23, 635, "shop"],
    [startX + 23, 676, "cottage"],
    [startX + 23, 635, "shop"],
    [startX + 57, 676, "townhouse"],
    [startX + 57, 635, "cottage"],
    [startX - 23, 574, "shop"],
    [startX - 23, 547, "shop"],
    [startX + 23, 574, "townhouse"],
    [startX + 23, 547, "shop"],
    [startX + 57, 574, "cottage"],
    [startX + 57, 547, "modern"],
    [startX + 103, 657, "cottage"],
    [startX + 103, 557, "cottage"],
    [startX - 23, 482, "cottage"],
    [startX + 23, 482, "modern"],
    [startX + 57, 482, "cottage"],
  ];
  for (const [x, z, style] of houses)
    objects.push({
      id: `building-${objects.length}`,
      type: "building",
      x,
      z,
      width: 12,
      depth: 14,
      height: style === "townhouse" ? 8 : 5,
      style,
      rotation: 0,
      color: pick(random, TOWN_COLORS),
    });
  for (const z of [-598, -645, -673, -723])
    objects.push({
      id: `lamp-${z}`,
      type: "streetlight",
      x: townX + 7.8,
      z,
      height: 6,
    });
  for (const z of [688, 650, 572, 490])
    for (const x of [startX - 8, startX + 88])
      objects.push({
        id: `millbrook-lamp-${objects.length}`,
        type: "streetlight",
        x,
        z,
        height: 6,
      });
  for (const junction of nodes.filter((n) => n.townJunction))
    for (const id of junction.neighbors) {
      if (
        !edges.some(
          (edge) =>
            (edge.a === id && edge.b === junction.id) ||
            (!edge.oneWay && edge.a === junction.id && edge.b === id),
        )
      )
        continue;
      const approach = heading(get(id), junction);
      const p = move(move(junction, approach, -9), approach + Math.PI / 2, 6.9);
      objects.push({
        id: `millbrook-stop-${junction.id}-${id}`,
        type: "stop_sign",
        ...p,
        nodeId: junction.id,
        approach,
        height: 2.8,
      });
    }
  objects.push(
    {
      id: "millbrook-welcome",
      type: "town_sign",
      x: startX + 9,
      z: 650,
      text: "MILLBROOK",
      height: 3,
    },
    {
      id: "interstate-advance",
      type: "interstate_guide",
      x: startX + 11,
      z: 619,
      approach: 0,
      direction: "left",
      text: "Cedar Town",
      detail: "LEFT AFTER MARKET ST",
    },
    {
      id: "interstate-entrance",
      type: "interstate_guide",
      x: startX + 11,
      z: 538,
      approach: 0,
      direction: "left",
      text: "North entrance",
      detail: "INTERSTATE 08",
    },
    {
      id: "interstate-ramp",
      type: "interstate_guide",
      x: move(ramp, -Math.PI / 2, 15).x,
      z: ramp.z - 8,
      approach: -Math.PI / 2,
      direction: "straight",
      text: "Cedar Town",
      detail: "ACCELERATE TO MERGE",
    },
  );
  for (let i = 0; i < 210; i++) {
    const x = (random() > 0.5 ? 1 : -1) * (65 + random() * 200);
    const p = { x, z: -760 + random() * 1480 };
    const nearConnector = connectorRoads.some(
      (road) => nearestOnPath(p, road.points).distance < road.width / 2 + 8,
    );
    if (
      nearConnector ||
      objects.some((o) => o.type === "building" && dist(p, o) < 18)
    )
      continue;
    const height = 5 + random() * 9;
    objects.push({
      id: `tree-${i}`,
      type: "tree",
      ...p,
      height,
      kind: random() > 0.25 ? "pine" : "round",
    });
  }
  for (let i = 0; i < 10; i++) {
    const x = (i % 2 ? 1 : -1) * (270 + random() * 70);
    const z = -700 + random() * 1400;
    const height = 20 + random() * 35;
    const width = 70 + random() * 60;
    objects.push({
      id: `hill-${i}`,
      type: "hill",
      x,
      z,
      height,
      width,
      depth: 80,
    });
  }
  for (const i of [2, 5])
    objects.push({
      id: `overpass-${i}`,
      type: "overpass",
      x: get(`h${i}`).x,
      z: get(`h${i}`).z - 45,
      width: 230,
      depth: 13,
      height: 9,
    });
  for (const [i, direction, detail] of [
    [3, "straight", "CONTINUE NORTH"],
    [5, "right", "EXIT 6 · KEEP RIGHT"],
  ] as const)
    objects.push({
      id: `highway-sign-${i}`,
      type: "highway_sign",
      x: get(`h${i}`).x,
      z: get(`h${i}`).z + 60,
      width: 18,
      height: 8,
      text: "Cedar Town",
      direction,
      detail,
    });
  objects.push({
    id: "cedar-welcome",
    type: "town_sign",
    x: townX + 9,
    z: -588,
    text: "CEDAR TOWN",
    height: 3,
  });
  const world: World = {
    seed,
    type: "highway",
    theme,
    nodes,
    byId,
    edges,
    objects,
    roadSamples,
    connectorRoads,
    shoulderOpenings: [
      [mergeStart - 5, mergeEnd + 8],
      [exitStart - 8, exitSplit + 15],
    ],
    xs: [-350, 350],
    zs: [-800, 720],
    bounds: { minX: -370, maxX: 370, minZ: -805, maxZ: 740 },
    startNode: start.id,
    nextNode: market.id,
    destination: destination.id,
    route: { ids: [], points: [], crossings: [], length: 0 },
  };
  world.route = highwayRoute(world, [
    start.id,
    market.id,
    rampJunction.id,
    ramp.id,
    merge.id,
    "h3",
    "h4",
    "h5",
    "h6",
    exit.id,
    town.id,
    destination.id,
  ]);
  world.destinationStopLine = {
    ...move(last(world.route.points), 0, 1.4),
    heading: 0,
  };
  return world;
}
