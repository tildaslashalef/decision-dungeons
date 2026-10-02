// The driving world: a road graph, the routes over it, and the static
// objects the scene draws and the simulation collides with.

import type { PathPoint, Point } from "./geometry.ts";

export type WorldType = "town" | "city" | "highway";
export type Control = "stop" | "signal" | "none";

export interface Theme {
  name: string;
  subtitle: string;
  /** Junctions per side of the grid (town and city). */
  size: number;
  traffic: number;
  /** Share of blocks that are built up rather than parks. */
  buildings: number;
  /** Default speed limit, m/s. */
  limit: number;
  laneOffset?: number;
}

export interface Junction extends Point {
  id: string;
  i?: number;
  j?: number;
  control: Control;
  /** Seconds added to the clock when reading this junction's signal. */
  offset: number;
  neighbors: string[];
  /** A Millbrook junction on the highway map: a crossing with stop signs. */
  townJunction?: boolean;
}

export type RoadKind =
  | "local"
  | "ramp_turn"
  | "onramp"
  | "merge"
  | "interstate"
  | "exit"
  | "offramp"
  | "town";

export interface Road {
  id: string;
  a: string;
  b: string;
  length: number;
  width: number;
  speedLimit: number;
  name: string;
  kind?: RoadKind;
  oneWay?: boolean;
  /** The lane driven from a to b, when the road is not a straight grid street. */
  path?: PathPoint[];
  /** A two-way connector's centerline; the b→a lane is offset from it. */
  centerline?: PathPoint[];
  laneOffset?: number;
}

/** A junction a route passes through, with the station of its stop line. */
export interface Crossing extends Point {
  nodeId: string;
  approach: number;
  exit: number;
  stopS: number;
}

/** A stretch of a highway route with one kind of road. */
export interface Section {
  kind: RoadKind;
  name: string;
  startS: number;
  endS: number;
  speedLimit: number;
  laneHalfWidth: number;
}

export interface Route {
  ids: string[];
  points: PathPoint[];
  crossings: Crossing[];
  sections?: Section[];
  length: number;
}

export interface ConnectorRoad {
  id: string;
  points: PathPoint[];
  width: number;
  kind: RoadKind;
  twoWay: boolean;
}

interface Placed extends Point {
  id: string;
}

export interface Building extends Placed {
  type: "building";
  style:
    | "skyscraper"
    | "apartment"
    | "shop"
    | "cottage"
    | "modern"
    | "townhouse";
  width: number;
  depth: number;
  height: number;
  color: string;
  roof?: string;
  rotation: number;
}

export interface Parcel extends Placed {
  type: "parcel";
  width: number;
  depth: number;
  park: boolean;
}

export interface Tree extends Placed {
  type: "tree";
  height: number;
  kind: "round" | "pine";
}

export interface Bench extends Placed {
  type: "bench";
  rotation: number;
}

export interface TrafficControl extends Placed {
  type: "stop_sign" | "traffic_light";
  nodeId: string;
  approach: number;
  height: number;
}

export interface Streetlight extends Placed {
  type: "streetlight";
  height: number;
}

export interface TownSign extends Placed {
  type: "town_sign";
  text: string;
  height: number;
}

export type SignDirection = "left" | "right" | "straight";

export interface InterstateGuide extends Placed {
  type: "interstate_guide";
  approach: number;
  direction: SignDirection;
  text: string;
  detail: string;
}

export interface Hill extends Placed {
  type: "hill";
  height: number;
  width: number;
  depth: number;
}

export interface Overpass extends Placed {
  type: "overpass";
  width: number;
  depth: number;
  height: number;
}

export interface HighwaySign extends Placed {
  type: "highway_sign";
  width: number;
  height: number;
  text: string;
  direction: SignDirection;
  detail: string;
}

export type WorldObject =
  | Building
  | Parcel
  | Tree
  | Bench
  | TrafficControl
  | Streetlight
  | TownSign
  | InterstateGuide
  | Hill
  | Overpass
  | HighwaySign;

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface World {
  seed: number;
  type: WorldType;
  theme: Theme;
  nodes: Junction[];
  byId: Record<string, Junction>;
  edges: Road[];
  objects: WorldObject[];
  xs: number[];
  zs: number[];
  bounds: Bounds;
  startNode: string;
  nextNode: string;
  destination: string;
  /** The player's route; replaced when the player is rerouted. */
  route: Route;
  /** The interstate's sampled centerline (highway only). */
  roadSamples?: PathPoint[];
  connectorRoads?: ConnectorRoad[];
  /** Stations where the interstate's shoulder opens to a ramp (highway only). */
  shoulderOpenings?: [number, number][];
  destinationStopLine?: Point & { heading: number };
}

export function junction(world: World, id: string): Junction {
  const node = world.byId[id];
  if (!node) throw new Error(`no junction ${id}`);
  return node;
}

export const isBuilding = (o: WorldObject): o is Building =>
  o.type === "building";
