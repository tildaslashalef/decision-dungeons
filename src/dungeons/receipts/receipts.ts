// Receipts: expense claims from a Harborline trip. Reimburse a receipt or
// not against the travel policy, read its total, its currency, and its kind,
// from the receipt as data, as a printed slip's picture, or both. The same
// receipts are asked as text and as a picture, so a comparison shows
// whether seeing adds anything to reading. Cases come from a case set
// (generate.ts writes them).

import type { Answers } from "../../contract/answer.ts";
import type {
  JsonValue,
  NoulQuestion,
  Question,
  Request,
} from "../../contract/request.ts";
import type { TextCase } from "../text/cases.ts";
import { type TextLevel, textDungeon } from "../text/text-dungeon.ts";
import {
  ALCOHOL,
  type Category,
  LIMITS,
  printed,
  type Receipt,
  type ReceiptInput,
  TRIP,
} from "./generate.ts";

export const POLICY = `Harborline reimburses a receipt only when all three hold: it is dated within the trip, ${TRIP.from} to ${TRIP.to}; its total is at most the limit for its kind of expense, in the receipt's own currency (meals ${LIMITS.meals}, taxi ${LIMITS.taxi}, lodging ${LIMITS.lodging}, office supplies ${LIMITS.supplies}); and nothing on it is alcohol.`;

const APPROVE: NoulQuestion = {
  type: "noul",
  instructions: `${POLICY} Should this receipt be reimbursed?`,
  criteria: {
    true: "reimburse it",
    false: "reject it: outside the trip, over its limit, or with alcohol",
  },
};

const CURRENCY: Question = {
  type: "choice",
  instructions: "In which currency is the receipt?",
  criteria: {
    USD: "US dollars ($)",
    EUR: "euros (€)",
    GBP: "pounds sterling (£)",
  },
};

const CATEGORY: Question = {
  type: "choice",
  instructions: "What kind of expense is it?",
  criteria: {
    meals: "a meal: a restaurant, café, or bar",
    taxi: "a taxi or car ride",
    lodging: "a hotel stay",
    supplies: "office supplies",
  },
};

const TOTAL_INSTRUCTIONS =
  "What is the receipt's total, the amount actually charged?";
/** Stands in a level's questions; each case's own four totals replace it (`questions`). */
const TOTAL_PER_CASE: Question = {
  type: "choice",
  instructions: TOTAL_INSTRUCTIONS,
  criteria: { "per case": null },
};

function totalQuestion(c: TextCase): Question {
  const { total_options } = c.input as unknown as ReceiptInput;
  return {
    type: "choice",
    instructions: TOTAL_INSTRUCTIONS,
    criteria: Object.fromEntries(total_options.map((o) => [o, null])),
  };
}

/** What an image-only level's decider is told besides the picture. */
const CLAIM =
  "An expense claim. Its receipt is the attached picture; nothing else is known about it.";

const LEVELS: TextLevel[] = [
  {
    id: "policy-text",
    title: "Policy, as text",
    description:
      "The receipt as data: reimburse only inside the trip, within its kind's limit, and with no alcohol. Any autopilot can read it. Pass with 90% right.",
    questions: { approve: APPROVE },
  },
  {
    id: "policy-image",
    title: "Policy, from the picture",
    description:
      "The same receipts as printed slips only: dates, amounts, and drinks must be read off the picture.",
    questions: { approve: APPROVE },
    casesOf: "policy-text",
    images: "only",
    tags: ["images"],
  },
  {
    id: "policy-both",
    title: "Picture and text",
    description:
      "The same receipts again, the slip beside the data: does seeing add anything to reading?",
    questions: { approve: APPROVE },
    casesOf: "policy-text",
    images: "with-text",
    tags: ["images"],
  },
  {
    id: "total",
    title: "Read the total",
    description:
      "Which of four amounts did the card pay? The subtotal, the sum before the tip, and swapped digits stand beside it.",
    questions: { total: TOTAL_PER_CASE },
    images: "only",
    tags: ["images"],
  },
  {
    id: "all-questions",
    title: "Everything on the slip",
    description:
      "Reimburse or not, the total, the currency, and the kind of expense: four questions about each picture in one request.",
    questions: {
      approve: APPROVE,
      total: TOTAL_PER_CASE,
      currency: CURRENCY,
      category: CATEGORY,
    },
    images: "only",
    tags: ["images", "many-questions"],
  },
];

const receiptOf = (c: TextCase): Receipt =>
  (c.input as unknown as ReceiptInput).receipt;

function state(c: TextCase, level: TextLevel): JsonValue {
  return level.images === "only"
    ? CLAIM
    : (receiptOf(c) as unknown as JsonValue);
}

function questions(c: TextCase, level: TextLevel): Record<string, Question> {
  if (!level.questions.total) return level.questions;
  return { ...level.questions, total: totalQuestion(c) };
}

const asReceipt = (request: Request): Receipt => {
  const s = request.state;
  if (
    !s ||
    typeof s !== "object" ||
    Array.isArray(s) ||
    !Array.isArray(s.items)
  )
    throw new Error(
      "the receipt is only in the picture, which the rule cannot see",
    );
  return s as unknown as Receipt;
};

/** The kind of expense, from the lines a receipt of each kind carries. */
function categoryOf(r: Receipt): Category {
  const items = r.items.map((l) => l.item).join("\n");
  if (/^Fare \(/m.test(items)) return "taxi";
  if (/^Room, /m.test(items)) return "lodging";
  if (/Paper|Toner|Notebooks|Pens|Sticky|Cable|Clips/.test(items))
    return "supplies";
  return "meals";
}

/** The baseline: the policy applied exactly to the receipt as data. */
function rule(request: Request): Answers {
  const r = asReceipt(request);
  const answers: Answers = {};
  if (request.questions.approve) {
    const inTrip = r.date >= TRIP.from && r.date <= TRIP.to;
    const within = r.total <= LIMITS[categoryOf(r)];
    const dry = !r.items.some((l) => ALCOHOL.includes(l.item));
    answers.approve = {
      type: "noul",
      noul: inTrip && within && dry ? 0.95 : 0.05,
    };
  }
  return answers;
}

export const receipts = textDungeon({
  id: "receipts",
  title: "Receipts",
  description:
    "Expense receipts from a trip, as data and as printed slips: reimburse against the policy, read the total, the currency, and the kind. Known answers, scored per receipt.",
  levels: LEVELS,
  state,
  questions,
  rule,
  summary: (c: TextCase) => {
    const r = receiptOf(c);
    return `${r.merchant} ${printed(r.total, r.currency)}`;
  },
});
