// The player's config: autopilot defaults per dungeon, nuclis settings,
// the TypeSafe key. One JSON file, mode 600, in the config home.
// Environment variables override the file. The key leaves this module only
// as `effective(...).typesafeKey`, for the TypeSafe decider; every view the
// browser sees says only whether a key is set.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
  Autopilot,
  Backend,
  ConfigPatch,
  PublicConfig,
  Source,
} from "../contract/api.ts";

export interface StoredConfig {
  autopilot: Record<string, Autopilot>;
  nuclis: { bin?: string; backend?: Backend };
  typesafe: { apiKey?: string };
}

export interface Effective {
  nuclisBin: string;
  backend?: Backend;
  typesafeKey?: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const FILE = "config.json";
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const KEY = /^[\x21-\x7e]{8,512}$/;
const BIN_NAME = /^[A-Za-z0-9._-]{1,100}$/;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The config directory: DECISION_DUNGEONS_HOME when set (absolute only), else ~/.decision-dungeons. */
export function configHome(env: Record<string, string | undefined>): string {
  const override = env.DECISION_DUNGEONS_HOME;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override))
      throw new ConfigError("DECISION_DUNGEONS_HOME must be an absolute path");
    return override;
  }
  return join(homedir(), ".decision-dungeons");
}

function binFrom(value: unknown, where: string): string {
  if (
    typeof value !== "string" ||
    !(
      (isAbsolute(value) && value.length <= 1024 && !value.includes("\0")) ||
      BIN_NAME.test(value)
    )
  )
    throw new ConfigError(
      `${where} must be an absolute path or a command name`,
    );
  return value;
}

function backendFrom(value: unknown, where: string): Backend {
  if (value !== "cpu" && value !== "metal")
    throw new ConfigError(`${where} must be cpu or metal`);
  return value;
}

function keyFrom(value: unknown, where: string): string {
  if (typeof value !== "string" || !KEY.test(value))
    throw new ConfigError(
      `${where} must be 8 to 512 printable characters with no spaces`,
    );
  return value;
}

function autopilotFrom(value: unknown, where: string): Autopilot {
  if (
    !isObject(value) ||
    typeof value.decider !== "string" ||
    !NAME.test(value.decider) ||
    typeof value.model !== "string" ||
    !NAME.test(value.model)
  )
    throw new ConfigError(`${where} must be { decider, model }`);
  return { decider: value.decider, model: value.model };
}

function section(raw: Json, key: string): Json {
  const value = raw[key];
  if (value === undefined) return {};
  if (!isObject(value)) throw new ConfigError(`${key} must be an object`);
  return value;
}

/** Parses the stored file; missing sections are empty. */
export function parseStored(raw: unknown): StoredConfig {
  if (!isObject(raw)) throw new ConfigError("the config must be an object");
  const config: StoredConfig = { autopilot: {}, nuclis: {}, typesafe: {} };
  for (const [dungeon, value] of Object.entries(section(raw, "autopilot"))) {
    if (!NAME.test(dungeon))
      throw new ConfigError(`autopilot ${dungeon}: not a dungeon id`);
    config.autopilot[dungeon] = autopilotFrom(value, `autopilot.${dungeon}`);
  }
  const nuclis = section(raw, "nuclis");
  if (nuclis.bin !== undefined)
    config.nuclis.bin = binFrom(nuclis.bin, "nuclis.bin");
  if (nuclis.backend !== undefined)
    config.nuclis.backend = backendFrom(nuclis.backend, "nuclis.backend");
  const typesafe = section(raw, "typesafe");
  if (typesafe.apiKey !== undefined)
    config.typesafe.apiKey = keyFrom(typesafe.apiKey, "typesafe.apiKey");
  return config;
}

/** Parses a patch from the browser. */
export function parsePatch(raw: unknown): ConfigPatch {
  if (!isObject(raw)) throw new ConfigError("the patch must be an object");
  for (const key of Object.keys(raw))
    if (!["autopilot", "nuclis", "typesafe"].includes(key))
      throw new ConfigError(`unknown setting ${key}`);
  const patch: ConfigPatch = {};
  if (raw.autopilot !== undefined) {
    patch.autopilot = {};
    for (const [dungeon, value] of Object.entries(section(raw, "autopilot"))) {
      if (!NAME.test(dungeon))
        throw new ConfigError(`autopilot ${dungeon}: not a dungeon id`);
      patch.autopilot[dungeon] =
        value === null ? null : autopilotFrom(value, `autopilot.${dungeon}`);
    }
  }
  if (raw.nuclis !== undefined) {
    const nuclis = section(raw, "nuclis");
    patch.nuclis = {};
    if (nuclis.bin !== undefined)
      patch.nuclis.bin =
        nuclis.bin === null ? null : binFrom(nuclis.bin, "nuclis.bin");
    if (nuclis.backend !== undefined)
      patch.nuclis.backend =
        nuclis.backend === null
          ? null
          : backendFrom(nuclis.backend, "nuclis.backend");
  }
  if (raw.typesafe !== undefined) {
    const typesafe = section(raw, "typesafe");
    patch.typesafe = {};
    if (typesafe.apiKey !== undefined)
      patch.typesafe.apiKey =
        typesafe.apiKey === null
          ? null
          : keyFrom(typesafe.apiKey, "typesafe.apiKey");
  }
  return patch;
}

function applyPatch(config: StoredConfig, patch: ConfigPatch): StoredConfig {
  const next = structuredClone(config);
  for (const [dungeon, value] of Object.entries(patch.autopilot ?? {})) {
    if (value === null) delete next.autopilot[dungeon];
    else next.autopilot[dungeon] = value;
  }
  const n = patch.nuclis;
  if (n?.bin === null) delete next.nuclis.bin;
  else if (n?.bin !== undefined) next.nuclis.bin = n.bin;
  if (n?.backend === null) delete next.nuclis.backend;
  else if (n?.backend !== undefined) next.nuclis.backend = n.backend;
  const t = patch.typesafe;
  if (t?.apiKey === null) delete next.typesafe.apiKey;
  else if (t?.apiKey !== undefined) next.typesafe.apiKey = t.apiKey;
  return next;
}

export class ConfigStore {
  readonly file: string;
  /** Writes run one at a time, so concurrent patches never lose each other. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly home: string,
    private readonly env: Record<string, string | undefined>,
  ) {
    this.file = join(home, FILE);
  }

  async load(): Promise<StoredConfig> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { autopilot: {}, nuclis: {}, typesafe: {} };
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ConfigError(`${this.file} is not valid JSON`);
    }
    return parseStored(raw);
  }

  update(patch: ConfigPatch): Promise<StoredConfig> {
    const next = this.queue.then(async () => {
      const config = applyPatch(await this.load(), patch);
      await this.write(config);
      return config;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private async write(config: StoredConfig): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    // The mode passed to writeFile is masked by the umask; set it outright.
    await chmod(temporary, 0o600);
    await rename(temporary, this.file);
  }

  effective(config: StoredConfig): Effective {
    const bin = this.env.NUCLIS_BIN || config.nuclis.bin || "nuclis";
    const key = this.env.TYPESAFE_API_KEY || config.typesafe.apiKey;
    return {
      nuclisBin: bin,
      ...(config.nuclis.backend ? { backend: config.nuclis.backend } : {}),
      ...(key ? { typesafeKey: key } : {}),
    };
  }

  publicView(config: StoredConfig): PublicConfig {
    const binSource: Source = this.env.NUCLIS_BIN
      ? "env"
      : config.nuclis.bin
        ? "file"
        : "default";
    const keySource = this.env.TYPESAFE_API_KEY
      ? "env"
      : config.typesafe.apiKey
        ? "file"
        : undefined;
    return {
      home: this.home,
      autopilot: config.autopilot,
      nuclis: {
        bin: this.effective(config).nuclisBin,
        binSource,
        ...(config.nuclis.backend ? { backend: config.nuclis.backend } : {}),
      },
      typesafe: { keySet: !!keySource, ...(keySource ? { keySource } : {}) },
    };
  }
}
