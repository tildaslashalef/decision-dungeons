// The browser's side of the HTTP API. Responses are the server's typed
// bodies; a failure becomes an ApiError carrying the server's code.

import type { Decision } from "../contract/answer.ts";
import type {
  ApiErrorBody,
  ApiErrorCode,
  ConfigPatch,
  DecideBody,
  DeciderView,
  PublicConfig,
} from "../contract/api.ts";

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly code: ApiErrorCode | "network",
    message: string,
  ) {
    super(message);
  }
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  const error = (value as ApiErrorBody | null)?.error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  );
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: init.body ? { "Content-Type": "application/json" } : {},
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError("network", "The server is not answering.");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (isErrorBody(body))
      throw new ApiError(body.error.code, body.error.message);
    throw new ApiError("unavailable", `HTTP ${res.status}`);
  }
  // The server's bodies are typed at their source (src/server/app.ts).
  return body as T;
}

export const api = {
  deciders: () =>
    call<{ deciders: DeciderView[] }>("/api/deciders").then((r) => r.deciders),
  config: () => call<PublicConfig>("/api/config"),
  updateConfig: (patch: ConfigPatch) =>
    call<PublicConfig>("/api/config", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  decide: (body: DecideBody, signal?: AbortSignal) =>
    call<Decision>("/api/decide", {
      method: "POST",
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }),
};
