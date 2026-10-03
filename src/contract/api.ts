// The HTTP API's bodies, shared by the server and the browser.

import type { DeciderStatus, ModelInfo } from "./decider.ts";
import type { DecideErrorCode } from "./errors.ts";
import type { Request } from "./request.ts";

export type Source = "env" | "file" | "default";

export interface Autopilot {
  decider: string;
  model: string;
}

/** The config as the browser sees it: never a key, only whether one is set. */
export interface PublicConfig {
  home: string;
  autopilot: Record<string, Autopilot>;
  nuclis: { url: string; urlSource: Source };
  typesafe: { keySet: boolean; keySource?: Exclude<Source, "default"> };
}

/** PUT /api/config. A field set to null is cleared. */
export interface ConfigPatch {
  autopilot?: Record<string, Autopilot | null>;
  nuclis?: { url?: string | null };
  typesafe?: { apiKey?: string | null };
}

export interface DeciderView {
  id: string;
  label: string;
  status: DeciderStatus;
  models: ModelInfo[];
  /** Why the models could not be listed, when the decider is configured but listing failed. */
  modelsError?: string;
}

/** POST /api/decide. */
export interface DecideBody {
  dungeon: string;
  decider: string;
  model: string;
  request: Request;
  seed?: number;
}

export type ApiErrorCode =
  | DecideErrorCode
  | "bad_request"
  | "too_large"
  | "busy"
  | "forbidden"
  | "not_found"
  | "config_error"
  | "cases_unavailable";

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}
