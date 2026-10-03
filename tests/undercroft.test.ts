import { describe, expect, test } from "bun:test";
import { decideWith } from "../src/contract/decider.ts";
import type { Request } from "../src/contract/request.ts";
import { parseRequest } from "../src/contract/validate.ts";
import { randomDecider } from "../src/deciders/random.ts";
import type { AnyDungeon } from "../src/dungeons/dungeon.ts";
import { runEpisode } from "../src/dungeons/run.ts";
import { playTurn } from "../src/dungeons/turn.ts";
import {
  nearMonster,
  optimalMoves,
  shortestPath,
  type Tile,
} from "../src/dungeons/undercroft/map.ts";
import { mapImage, mapPicture } from "../src/dungeons/undercroft/picture.ts";
import {
  levelMap,
  textMap,
  type UndercroftRun,
  undercroft,
} from "../src/dungeons/undercroft/undercroft.ts";
import { crc32, encodePng, type PaletteImage } from "../src/lib/png.ts";

const dungeon = undercroft as AnyDungeon;
const options = (model: string, seed = 1) => ({
  model,
  seed,
  signal: AbortSignal.timeout(2000),
});
const byRule = (r: Request) =>
  decideWith(undercroft.rule, r, options("baseline"));

/** Decodes a palette PNG this writer made: chunks, CRCs, zlib, unfiltered rows. */
async function decodePng(png: Uint8Array): Promise<PaletteImage> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let at = 8;
  let width = 0;
  let height = 0;
  let palette: [number, number, number][] = [];
  const idat: Uint8Array[] = [];
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    expect(view.getUint32(at + 8 + length)).toBe(
      crc32(png.subarray(at + 4, at + 8 + length)),
    );
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      expect([...data.subarray(8)]).toEqual([8, 3, 0, 0, 0]);
    }
    if (type === "PLTE")
      palette = Array.from({ length: length / 3 }, (_, i) => [
        data[i * 3] as number,
        data[i * 3 + 1] as number,
        data[i * 3 + 2] as number,
      ]);
    if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const raw = new Uint8Array(
    await new Response(
      new Blob(idat as BlobPart[])
        .stream()
        .pipeThrough(new DecompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width + 1)]).toBe(0);
    pixels.set(
      raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)),
      y * width,
    );
  }
  return { width, height, palette, pixels };
}

describe("the PNG writer", () => {
  test("CRC-32 is the standard one", () => {
    const bytes = new TextEncoder().encode("123456789");
    expect(crc32(bytes)).toBe(0xcbf43926);
    expect(crc32(bytes)).toBe(Bun.hash.crc32(bytes));
  });

  test("a map picture decodes to the pixels it was drawn from", async () => {
    const m = levelMap("keys", 3);
    const image = mapImage(m, m.start);
    const back = await decodePng(await encodePng(image));
    expect(back.width).toBe(image.width);
    expect(back.height).toBe(image.height);
    expect(back.palette).toEqual(image.palette);
    expect(back.pixels).toEqual(image.pixels);
  });

  test("the same map is the same bytes", async () => {
    const m = levelMap("keys", 1);
    const url = await mapPicture(m, m.start);
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(await mapPicture(levelMap("keys", 1), m.start)).toBe(url);
    expect(Bun.hash(url).toString(16)).toBe(PINNED_HASH);
  });
});

/** The keys map of seed 1 as a picture, pinned: a change to the tiles or the writer shows here. */
const PINNED_HASH = "cbed029b484ccf51";

describe("undercroft maps", () => {
  test("every level's map has a safe way out, the stairs far from the start", () => {
    for (const level of undercroft.levels)
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const m = levelMap(level.id, seed);
        expect(optimalMoves(m)).toBeGreaterThan(m.rows);
        const safe = shortestPath(m, m.start, [], { safe: true }) ?? [];
        expect(safe.length).toBe(optimalMoves(m));
        expect(levelMap(level.id, seed)).toEqual(m);
      }
  });

  test("keys come in order and each door needs its key", () => {
    for (const seed of [1, 2, 3, 4]) {
      const m = levelMap("keys", seed);
      const tiles = m.tiles.flat();
      for (const t of [
        "key:gold",
        "door:gold",
        "key:red",
        "door:red",
      ] as Tile[])
        expect(tiles).toContain(t);
      // Without picking up keys the stairs are out of reach.
      const noKeys = {
        ...m,
        tiles: m.tiles.map((row) =>
          row.map((t): Tile => (t.startsWith("key:") ? "wall" : t)),
        ),
      };
      expect(shortestPath(noKeys, m.start)).toBeNull();
    }
  });

  test("monsters make the optimum walk round them", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const m = levelMap("monsters", seed);
      expect(nearMonster(m, m.start)).toBe(false);
      const clear = {
        ...m,
        tiles: m.tiles.map((row) =>
          row.map((t): Tile => (t === "monster" ? "floor" : t)),
        ),
      };
      expect(optimalMoves(m)).toBeGreaterThan(optimalMoves(clear));
    }
  });
});

describe("undercroft runs", () => {
  test("the rule reaches the stairs at the optimum, and under fog within the bound", async () => {
    for (const level of [
      "corridors",
      "keys",
      "monsters",
      "fog",
      "picture-both",
    ])
      for (const seed of [1, 2]) {
        const result = await runEpisode(
          dungeon,
          level,
          seed,
          { id: "rule", model: "baseline" },
          byRule,
        );
        expect(result.outcome.passed).toBe(true);
        expect(result.outcome.violations).toBe(0);
        expect(result.outcome.metrics.hp_lost).toBe(0);
        if (level !== "fog")
          expect(result.outcome.metrics.steps).toBe(
            result.outcome.metrics.optimal as number,
          );
      }
  });

  test("random bumps, wanders, and fails", async () => {
    for (const level of ["corridors", "monsters"]) {
      const result = await runEpisode(
        dungeon,
        level,
        1,
        { id: "random", model: "uniform" },
        (r) => decideWith(randomDecider(), r, options("uniform")),
      );
      expect(result.outcome.passed).toBe(false);
      expect(result.outcome.violations).toBeGreaterThan(0);
    }
  });

  test("requests are valid; pictures only where the level shows them; the rule cannot see a picture", async () => {
    for (const level of undercroft.levels) {
      const run = undercroft.create(1, level.id);
      await undercroft.render?.(run);
      const { request } = undercroft.observe(run);
      expect(() => parseRequest(request)).not.toThrow();
      expect(!!request.images).toBe(level.images !== undefined);
      const s = request.state as Record<string, unknown>;
      expect("map" in s).toBe(level.images !== "only");
    }
    const run = undercroft.create(1, "picture");
    await undercroft.render?.(run);
    await expect(byRule(undercroft.observe(run).request)).rejects.toThrow(
      "picture",
    );
    // A turn moves the hero, so the picture must be drawn again before asking.
    await playTurn(dungeon, run, async () => ({
      decider: "x",
      model: "x",
      answers: { move: { type: "choice", choice: "south" } },
      timings: { total: 0 },
    }));
    expect(() => undercroft.observe(run)).toThrow("render");
  });

  test("the next request says what the last move did", async () => {
    const run = undercroft.create(1, "corridors") as UndercroftRun;
    const move = (choice: string) =>
      playTurn(dungeon, run, async () => ({
        decider: "x",
        model: "x",
        answers: { move: { type: "choice", choice } },
        timings: { total: 0 },
      }));
    const state = () =>
      undercroft.observe(run).request.state as Record<string, unknown>;
    expect(state().last_move).toBeUndefined();
    // The start is the top-left corner: north is always a wall.
    await move("north");
    expect(state().last_move).toBe("north: walked into a wall, did not move");
    expect(run.bumps).toBe(1);
  });

  test("fog hides what is out of sight until the hero comes near", () => {
    const run = undercroft.create(1, "fog") as UndercroftRun;
    const before = textMap(run).join("").split("?").length;
    expect(before).toBeGreaterThan(run.map.rows * run.map.cols * 0.7);
    expect(textMap(undercroft.create(1, "corridors")).join("")).not.toContain(
      "?",
    );
  });
});
