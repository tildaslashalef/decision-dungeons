import { describe, expect, test } from "bun:test";
import {
  colorFrom,
  createLogger,
  type LoggerOptions,
  levelFrom,
} from "../src/server/log.ts";

const at = new Date(2026, 9, 2, 9, 5, 7, 42);

function capture(options: LoggerOptions = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    now: () => at,
    write: (line) => lines.push(line),
    ...options,
  });
  return { logger, lines };
}

describe("logger", () => {
  test("prints time, level, scope, message, and fields", () => {
    const { logger, lines } = capture();
    logger.child("server").child("http").info("GET /api/config", {
      status: 200,
      ms: 3,
      path: "has space",
      missing: undefined,
    });
    expect(lines).toEqual([
      '09:05:07.042 INFO  server:http GET /api/config status=200 ms=3 path="has space"',
    ]);
  });

  test("drops lines below the level", () => {
    const { logger, lines } = capture({ level: "warn" });
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(lines.map((l) => l.split(" ").slice(1).join(" "))).toEqual([
      "WARN  c",
      "ERROR d",
    ]);
  });

  test("an error field prints its message, then its indented stack", () => {
    const { logger, lines } = capture();
    logger.error("failed", { error: new Error("boom") });
    expect(lines[0]).toEndWith("ERROR failed error=boom");
    expect(lines[1]).toStartWith("    Error: boom");
  });

  test("colors only when asked", () => {
    const plain = capture();
    plain.logger.warn("x");
    expect(plain.lines[0]).not.toContain("\x1b[");
    const colored = capture({ color: true });
    colored.logger.warn("x");
    expect(colored.lines[0]).toContain("\x1b[33mWARN \x1b[0m");
  });

  test("level and color come from the environment", () => {
    expect(levelFrom({})).toBe("info");
    expect(levelFrom({ DECISION_DUNGEONS_LOG: "DEBUG" })).toBe("debug");
    expect(levelFrom({ DECISION_DUNGEONS_LOG: "loud" })).toBe("info");
    expect(colorFrom({}, true)).toBe(true);
    expect(colorFrom({}, false)).toBe(false);
    expect(colorFrom({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colorFrom({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(colorFrom({ FORCE_COLOR: "0" }, true)).toBe(false);
  });
});
