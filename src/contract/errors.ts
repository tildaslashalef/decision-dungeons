// Typed decision failures. A decider never crashes its caller and never
// repairs a bad answer; it throws one of these.

export type DecideErrorCode =
  /** Missing key or binary: the player must change the config. */
  | "unconfigured"
  /** The decider refused the request (bad request, bad key, rate limit, unknown model). */
  | "rejected"
  /** The decider could not be reached or failed on its side. */
  | "unavailable"
  | "timeout"
  /** The decider answered, but not a valid answer to the request. */
  | "invalid_answer";

export class DecideError extends Error {
  override readonly name = "DecideError";
  constructor(
    readonly code: DecideErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function isDecideError(value: unknown): value is DecideError {
  return value instanceof DecideError;
}
