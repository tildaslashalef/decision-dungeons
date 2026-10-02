// The boundary between untrusted JSON and the contract's types. Requests
// arrive from the browser; answers arrive from deciders. Both are checked
// field by field; anything wrong is a typed error, never repaired.

import type {
  Answer,
  AnswerDebug,
  Answers,
  ChoiceAnswer,
  NoulAnswer,
  ScoreAnswer,
} from "./answer.ts";
import { DecideError } from "./errors.ts";
import type { JsonValue, Question, Request } from "./request.ts";

export const MAX_QUESTIONS = 32;
/** nuclis's per-request bound. */
export const MAX_IMAGES = 8;
/** Base64 characters across a request's images, under nuclis's 4 MiB body. */
export const MAX_IMAGE_CHARS = 3 * 1024 * 1024;
const IMAGE_URL =
  /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
export const MAX_OPTIONS = 64;

/** Probabilities are reported rounded (nuclis to 4 places), so sums drift a little. */
const SUM_TOLERANCE = 0.01;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isUnit = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0 && value <= 1;

export class RequestError extends Error {
  override readonly name = "RequestError";
}

function questionFrom(id: string, raw: unknown): Question {
  const fail = (why: string) => new RequestError(`question ${id}: ${why}`);
  if (!isObject(raw)) throw fail("must be an object");
  if (typeof raw.instructions !== "string")
    throw fail("instructions must be a string");
  const instructions = raw.instructions;
  switch (raw.type) {
    case "choice": {
      if (!isObject(raw.criteria))
        throw fail("criteria must be an object of option -> description");
      const entries = Object.entries(raw.criteria);
      if (entries.length === 0 || entries.length > MAX_OPTIONS)
        throw fail(`takes 1 to ${MAX_OPTIONS} options`);
      const criteria: Record<string, string | null> = {};
      for (const [key, description] of entries) {
        if (key === "") throw fail("an option key is empty");
        if (description !== null && typeof description !== "string")
          throw fail(`option ${key}: description must be a string or null`);
        criteria[key] = description;
      }
      return { type: "choice", instructions, criteria };
    }
    case "score": {
      const levels = raw.criteria;
      if (
        !Array.isArray(levels) ||
        levels.length === 0 ||
        levels.length > MAX_OPTIONS ||
        !levels.every((level) => typeof level === "string")
      )
        throw fail(`criteria must be 1 to ${MAX_OPTIONS} level strings`);
      return { type: "score", instructions, criteria: levels };
    }
    case "noul": {
      if (raw.criteria === undefined) return { type: "noul", instructions };
      if (!isObject(raw.criteria))
        throw fail("criteria must be an object keyed true and false");
      const criteria: { true?: string | null; false?: string | null } = {};
      for (const [key, description] of Object.entries(raw.criteria)) {
        if (key !== "true" && key !== "false")
          throw fail("criteria takes only the keys true and false");
        if (description !== null && typeof description !== "string")
          throw fail(`option ${key}: description must be a string or null`);
        criteria[key] = description;
      }
      return { type: "noul", instructions, criteria };
    }
    default:
      throw fail("type must be choice, score, or noul");
  }
}

/** Parses a request from untrusted JSON. Throws RequestError naming the problem. */
export function parseRequest(raw: unknown): Request {
  if (!isObject(raw)) throw new RequestError("the request must be an object");
  if (!("state" in raw)) throw new RequestError("the request needs a state");
  if (!isObject(raw.questions))
    throw new RequestError("questions must be an object of id -> question");
  const entries = Object.entries(raw.questions);
  if (entries.length === 0 || entries.length > MAX_QUESTIONS)
    throw new RequestError(`a request takes 1 to ${MAX_QUESTIONS} questions`);
  const questions: Record<string, Question> = {};
  for (const [id, question] of entries)
    questions[id] = questionFrom(id, question);
  // JSON.parse output is JSON by construction; callers parse before calling.
  const request: Request = { state: raw.state as JsonValue, questions };
  if (raw.images !== undefined) request.images = imagesFrom(raw.images);
  return request;
}

function imagesFrom(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IMAGES)
    throw new RequestError(`images must be a list of 1 to ${MAX_IMAGES}`);
  let chars = 0;
  for (const image of raw) {
    if (typeof image !== "string" || !IMAGE_URL.test(image))
      throw new RequestError(
        "each image must be a base64 data URL (png, jpeg, webp, or gif)",
      );
    chars += image.length;
  }
  if (chars > MAX_IMAGE_CHARS)
    throw new RequestError(
      `images take at most ${MAX_IMAGE_CHARS} characters in all`,
    );
  return raw as string[];
}

function invalid(id: string, why: string): DecideError {
  return new DecideError("invalid_answer", `answer ${id}: ${why}`);
}

function probabilitiesFrom(
  id: string,
  raw: unknown,
  keys: string[],
): Record<string, number> {
  if (!isObject(raw)) throw invalid(id, "probabilities must be an object");
  const out: Record<string, number> = {};
  let sum = 0;
  for (const [key, p] of Object.entries(raw)) {
    if (!keys.includes(key))
      throw invalid(id, `probability for ${key}, an option not offered`);
    if (!isUnit(p))
      throw invalid(id, `probability for ${key} is not in [0, 1]`);
    out[key] = p;
    sum += p;
  }
  if (sum > 1 + SUM_TOLERANCE) throw invalid(id, "probabilities sum above 1");
  if (Object.keys(out).length === keys.length && sum < 1 - SUM_TOLERANCE)
    throw invalid(id, "probabilities sum below 1");
  return out;
}

function debugFrom(id: string, raw: unknown): AnswerDebug {
  if (!isObject(raw)) throw invalid(id, "debug must be an object");
  const debug: AnswerDebug = {};
  if (raw.logits !== undefined) {
    if (!Array.isArray(raw.logits) || !raw.logits.every(isFiniteNumber))
      throw invalid(id, "logits must be finite numbers");
    debug.logits = raw.logits;
  }
  const numbers = [
    "temperature",
    "answerConfidence",
    "tokensRead",
    "stateKept",
  ] as const;
  for (const key of numbers) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!isFiniteNumber(value)) throw invalid(id, `${key} is not finite`);
    debug[key] = value;
  }
  if (raw.bucket !== undefined) {
    if (typeof raw.bucket !== "string")
      throw invalid(id, "bucket must be a string");
    debug.bucket = raw.bucket;
  }
  return debug;
}

function answerFrom(id: string, question: Question, raw: unknown): Answer {
  if (!isObject(raw)) throw invalid(id, "must be an object");
  // Jev may leave `type` out; when present it must match the question.
  if (raw.type !== undefined && raw.type !== question.type)
    throw invalid(
      id,
      `type ${String(raw.type)} for a ${question.type} question`,
    );
  const debug = raw.debug === undefined ? undefined : debugFrom(id, raw.debug);
  const confidence = (): number | undefined => {
    if (raw.confidence === undefined) return undefined;
    if (!isUnit(raw.confidence))
      throw invalid(id, "confidence is not in [0, 1]");
    return raw.confidence;
  };
  switch (question.type) {
    case "choice": {
      const keys = Object.keys(question.criteria);
      if (typeof raw.choice !== "string" || !keys.includes(raw.choice))
        throw invalid(
          id,
          `choice ${JSON.stringify(raw.choice)} is not an offered option`,
        );
      const answer: ChoiceAnswer = { type: "choice", choice: raw.choice };
      if (raw.probabilities !== undefined)
        answer.probabilities = probabilitiesFrom(id, raw.probabilities, keys);
      const c = confidence();
      if (c !== undefined) answer.confidence = c;
      if (debug) answer.debug = debug;
      return answer;
    }
    case "score": {
      const top = question.criteria.length - 1;
      if (!isFiniteNumber(raw.score) || raw.score < 0 || raw.score > top)
        throw invalid(id, `score is not a number in [0, ${top}]`);
      const answer: ScoreAnswer = { type: "score", score: raw.score };
      if (raw.probabilities !== undefined)
        answer.probabilities = probabilitiesFrom(
          id,
          raw.probabilities,
          question.criteria.map((_, i) => String(i)),
        );
      if (raw.legend !== undefined) {
        if (
          !isObject(raw.legend) ||
          !Object.values(raw.legend).every((v) => typeof v === "string")
        )
          throw invalid(id, "legend must map levels to strings");
        answer.legend = raw.legend as Record<string, string>;
      }
      const c = confidence();
      if (c !== undefined) answer.confidence = c;
      if (debug) answer.debug = debug;
      return answer;
    }
    case "noul": {
      if (!isUnit(raw.noul)) throw invalid(id, "noul is not in [0, 1]");
      const answer: NoulAnswer = { type: "noul", noul: raw.noul };
      if (debug) answer.debug = debug;
      return answer;
    }
  }
}

/**
 * Checks a decider's answers against the request it was asked: one valid
 * answer per question, nothing else. Throws DecideError("invalid_answer").
 */
export function validateAnswers(request: Request, raw: unknown): Answers {
  if (!isObject(raw))
    throw new DecideError("invalid_answer", "answers must be an object");
  for (const id of Object.keys(raw))
    if (!Object.hasOwn(request.questions, id))
      throw invalid(id, "answers a question that was not asked");
  const answers: Answers = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (!Object.hasOwn(raw, id)) throw invalid(id, "missing");
    answers[id] = answerFrom(id, question, raw[id]);
  }
  return answers;
}
