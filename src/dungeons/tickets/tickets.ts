// Ticket triage: support tickets from Harborline's customers. Route each
// to its team, score its urgency, tell a refund request from talk about
// money, and route tickets in four languages. Cases come from a case set
// (generate.ts writes them).

import type { Answers } from "../../contract/answer.ts";
import type { Request } from "../../contract/request.ts";
import type { TextCase } from "../text/cases.ts";
import { type TextLevel, textDungeon } from "../text/text-dungeon.ts";
import type { Ticket } from "./generate.ts";

const TEAM = {
  type: "choice" as const,
  instructions: "Which team should own this ticket?",
  criteria: {
    billing: "invoices, charges, refunds, credits, billing details",
    technical: "bugs, errors, outages, integrations, performance",
    account_access: "sign-in, SSO, MFA, seats and invitations",
    sales: "quotes, demos, add-ons, renewal pricing",
    privacy_security:
      "data deletion or export, security reviews, compromised accounts",
  },
};

const URGENCY = {
  type: "score" as const,
  instructions:
    "How urgent is this ticket for the customer's operations? Judge the impact, not the tone.",
  criteria: [
    "low: a question, idea, or cosmetic issue",
    "normal: something to fix, with a workaround or no near deadline",
    "high: a person or team is blocked, or a hard deadline is close",
    "critical: an outage, data loss, or security incident across the customer",
  ],
};

const REFUND = {
  type: "noul" as const,
  instructions:
    "Is the customer asking for money back: a refund, a credit, or a chargeback?",
  criteria: {
    true: "asks for money back",
    false: "no money asked back, even if billing is mentioned",
  },
};

const LEVELS: TextLevel[] = [
  {
    id: "routing",
    title: "Route the ticket",
    description:
      "Billing, technical, account access, sales, or privacy and security. Pass with 90% right.",
    questions: { team: TEAM },
  },
  {
    id: "urgency",
    title: "Urgency, not tone",
    description:
      "Score impact from low to critical: a furious note about a typo is low; a polite note that nobody can dispatch is critical.",
    questions: { urgency: URGENCY },
  },
  {
    id: "refunds",
    title: "Money back?",
    description:
      "Refunds, SLA credits, and chargeback threats, against invoices fixed with no refund wanted.",
    questions: { refund: REFUND },
  },
  {
    id: "languages",
    title: "Four languages",
    description:
      "Routing tickets written in Spanish, German, French, and Portuguese.",
    questions: { team: TEAM },
  },
];

const asTicket = (request: Request): Ticket => {
  const s = request.state;
  if (!s || typeof s !== "object" || Array.isArray(s))
    throw new Error("the state is not a ticket");
  return s as unknown as Ticket;
};

function team(text: string): string {
  if (
    /gdpr|erase|delete .*data|personal data|soc 2|questionnaire|compromis|security/.test(
      text,
    )
  )
    return "privacy_security";
  if (/refund|charge|invoice|credit|billing|vat|bank/.test(text))
    return "billing";
  if (
    /error|fail|bug|slow|disappeared|sync|typo|labels?\b|tracking page|feature/.test(
      text,
    )
  )
    return "technical";
  if (
    /sso|saml|locked out|mfa|authenticator|sign in|notification|invite|add two seats/.test(
      text,
    )
  )
    return "account_access";
  if (/quote|pricing|demo|add-on|renewal|module/.test(text)) return "sales";
  return "technical";
}

function urgency(text: string): number {
  if (
    /all (of )?our|everyone|nobody|no one|whole company|all \d+ users|disappeared|gone from|compromis|stopped/.test(
      text,
    )
  )
    return 3;
  if (
    /blocked|locked out|can't|cannot|by (monday|thursday|friday)|before .*(close|friday)|dispute|failing/.test(
      text,
    )
  )
    return 2;
  if (/question|idea|would love|typo|demo|no rush/.test(text)) return 0;
  return 1;
}

function refund(text: string): boolean {
  if (/no refund|don't need a refund|not (asking for )?a refund/.test(text))
    return false;
  return /refund|credit|chargeback|dispute|money back|reverse/.test(text);
}

function rule(request: Request): Answers {
  const t = asTicket(request);
  const text = `${t.subject}\n${t.message}`.toLowerCase();
  const answers: Answers = {};
  const q = request.questions;
  if (q.team?.type === "choice") {
    const choice = team(text);
    answers.team = {
      type: "choice",
      choice,
      probabilities: Object.fromEntries(
        Object.keys(q.team.criteria).map((k) => [k, k === choice ? 1 : 0]),
      ),
    };
  }
  if (q.urgency?.type === "score") {
    const level = urgency(text);
    answers.urgency = {
      type: "score",
      score: level,
      probabilities: Object.fromEntries(
        q.urgency.criteria.map((_, i) => [String(i), i === level ? 1 : 0]),
      ),
    };
  }
  if (q.refund)
    answers.refund = { type: "noul", noul: refund(text) ? 0.9 : 0.1 };
  return answers;
}

export const tickets = textDungeon({
  id: "tickets",
  title: "Ticket triage",
  description:
    "A support desk's queue: route each ticket, score its urgency, spot refund requests, in four languages. Known answers, scored per ticket.",
  levels: LEVELS,
  state: (c: TextCase) => c.input,
  rule,
  summary: (c: TextCase) => {
    const t = c.input as unknown as Ticket;
    const subject =
      t.subject.length > 48 ? `${t.subject.slice(0, 47)}…` : t.subject;
    return `${t.ticket} "${subject}"`;
  },
});
