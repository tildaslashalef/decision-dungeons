// A small leveled logger for the server: one line per event on stdout,
// ANSI-colored when stdout is a terminal. Server-only; never log a key or a
// request body through it.

export type Level = "debug" | "info" | "warn" | "error";
/** Extra context printed as `key=value` after the message. */
export type Fields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** The same logger with `scope` appended to its scope (`server:http`). */
  child(scope: string): Logger;
}

export interface LoggerOptions {
  /** Lines below this level are dropped. Default `info`. */
  level?: Level;
  color?: boolean;
  scope?: string;
  /** Receives each line without its newline; default writes to stdout. */
  write?: (line: string) => void;
  now?: () => Date;
}

const RANK: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const LABEL: Record<Level, string> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};
const TINT: Record<Level, string> = {
  debug: "90",
  info: "36",
  warn: "33",
  error: "1;31",
};

export const isLevel = (value: unknown): value is Level =>
  typeof value === "string" && Object.hasOwn(RANK, value);

/** `DECISION_DUNGEONS_LOG`, or `info` when unset or not a level. */
export function levelFrom(env: Record<string, string | undefined>): Level {
  const value = env.DECISION_DUNGEONS_LOG?.toLowerCase();
  return isLevel(value) ? value : "info";
}

/** `NO_COLOR` turns color off, `FORCE_COLOR` on; otherwise a TTY gets it. */
export function colorFrom(
  env: Record<string, string | undefined>,
  isTTY: boolean,
): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  return isTTY;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const clock = (d: Date) =>
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

function value(v: unknown): string {
  if (v instanceof Error) return value(v.message);
  if (typeof v === "string")
    return /^[^\s"=]+$/.test(v) ? v : JSON.stringify(v);
  if (v === undefined || typeof v !== "object") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const {
    level = "info",
    color = false,
    scope,
    write = (line: string) => process.stdout.write(`${line}\n`),
    now = () => new Date(),
  } = options;
  const paint = (code: string, text: string) =>
    color ? `\x1b[${code}m${text}\x1b[0m` : text;

  function emit(at: Level, message: string, fields: Fields = {}) {
    if (RANK[at] < RANK[level]) return;
    const parts = [paint("2", clock(now())), paint(TINT[at], LABEL[at])];
    if (scope) parts.push(paint("35", scope));
    parts.push(message);
    const stacks: string[] = [];
    for (const [key, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      parts.push(`${paint("2", `${key}=`)}${value(v)}`);
      if (v instanceof Error && v.stack) stacks.push(v.stack);
    }
    write(parts.join(" "));
    for (const stack of stacks) write(paint("2", stack.replace(/^/gm, "    ")));
  }

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (name) =>
      createLogger({
        ...options,
        scope: scope ? `${scope}:${name}` : name,
      }),
  };
}

/** The process logger, configured from the environment. */
export const log = createLogger({
  level: levelFrom(process.env),
  color: colorFrom(process.env, process.stdout.isTTY ?? false),
});
