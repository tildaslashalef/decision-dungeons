// Inbox: the mail of Harborline's finance operations lead. Spot phishing
// and fraud, file mail where it belongs, in four languages, and in long
// digests whose decisive line comes last. Cases come from a case set
// (generate.ts writes them).

import type { Answers } from "../../contract/answer.ts";
import type { JsonValue, Request } from "../../contract/request.ts";
import type { TextCase } from "../text/cases.ts";
import { type TextLevel, textDungeon } from "../text/text-dungeon.ts";
import { DOMAIN, ME } from "../text/vocab.ts";
import type { Email } from "./generate.ts";

const PHISHING = {
  type: "noul" as const,
  instructions:
    "Is this email phishing or fraud: a deceptive sender, link, or attachment, or a request for credentials, payment, gift cards, or changed bank details that the real sender would not make? Urgency alone is not fraud.",
  criteria: {
    true: "phishing or fraud",
    false: "genuine mail, however urgent",
  },
};

const ROUTE = {
  type: "choice" as const,
  instructions: `Where should ${ME.first} file this email?`,
  criteria: {
    reply: "someone expects a reply, review, or decision from her",
    read_later: "useful information; nothing to do",
    finance: "an invoice or receipt to process or keep",
    promotions: "newsletters and marketing",
    report_phishing: "a phishing or fraud attempt",
  },
};

const LEVELS: TextLevel[] = [
  {
    id: "phishing",
    title: "Phishing or not",
    description:
      "Lookalike domains, gift-card requests, changed bank details, and genuine mail that sounds just as urgent. Pass with 90% right.",
    questions: { phishing: PHISHING },
  },
  {
    id: "triage",
    title: "File the mail",
    description:
      "Reply, read later, finance, promotions, or report: one folder per email. Pass with 90% right.",
    questions: { route: ROUTE },
  },
  {
    id: "languages",
    title: "Four languages",
    description:
      "The same fraud and the same genuine mail in Spanish, German, French, and Portuguese.",
    questions: { phishing: PHISHING },
  },
  {
    id: "long",
    title: "Long digests",
    description:
      "Two thousand words of newsletter; when there is fraud, it is the last line. Past a short model's budget.",
    questions: { phishing: PHISHING },
  },
];

const host = (url: string): string | null => {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
  } catch {
    return null;
  }
};
const domainOf = (address: string): string =>
  (address.match(/@([^>\s]+)>?\s*$/)?.[1] ?? "").toLowerCase();
const registered = (hostname: string): string =>
  hostname.split(".").slice(-2).join(".");

const BRAND_SITES: Record<string, string[]> = {
  microsoft: ["microsoft.com"],
  docusign: ["docusign.net", "docusign.com"],
  okta: ["okta.com"],
  dropbox: ["dropbox.com"],
  dhl: ["dhl.com"],
  harborline: [
    DOMAIN,
    "harborline.okta.com",
    "harborline.sharepoint.com",
    "harborline.bamboohr.com",
    "harborline.app.netsuite.com",
  ],
};
const FREEMAIL = ["gmail.com", "outlook.com", "proton.me", "yahoo.com"];
const RISKY = /\.(html?|zip|iso|exe|js)$/i;
const LURES =
  /gift card|password|verify|re-?validate|suspend|customs fee|bank(ing)? (details|account)|new account|remittance|direct deposit|confidential|scratch the/gi;

/** A host that names a brand but is not one of its real sites. */
function impostor(hostname: string): boolean {
  return Object.entries(BRAND_SITES).some(
    ([brand, sites]) =>
      hostname.includes(brand) &&
      !sites.some((s) => hostname === s || hostname.endsWith(`.${s}`)),
  );
}

/** How suspicious the mail looks, from its headers, links, attachments, and words. */
export function suspicion(email: Partial<Email>): number {
  let score = 0;
  const from = domainOf(email.from ?? "");
  if (email.reply_to && domainOf(email.reply_to) !== from) score += 2;
  if (impostor(from)) score += 2;
  for (const link of email.links ?? []) {
    const target = host(link.url);
    const shown = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+/.test(link.text)
      ? host(link.text)
      : null;
    if (target && shown && registered(target) !== registered(shown)) score += 2;
    if (target && impostor(target)) score += 2;
  }
  for (const url of (email.body ?? "").match(/https?:\/\/[^\s)]+/g) ?? []) {
    const target = host(url);
    if (target && impostor(target)) score += 2;
  }
  if ((email.attachments ?? []).some((a) => RISKY.test(a.name))) score += 2;
  const lures = new Set(
    `${email.subject ?? ""} ${email.body ?? ""}`.toLowerCase().match(LURES) ??
      [],
  );
  if (FREEMAIL.includes(from) && lures.size) score += 2;
  score += Math.min(lures.size, 2);
  return score;
}

const asEmail = (state: JsonValue): Partial<Email> => {
  if (!state || typeof state !== "object" || Array.isArray(state))
    throw new Error("the state is not an email");
  return state as unknown as Partial<Email>;
};

function route(email: Partial<Email>, suspect: number): string {
  if (suspect >= 3) return "report_phishing";
  const text = `${email.subject ?? ""}\n${email.body ?? ""}`.toLowerCase();
  if (
    (email.attachments ?? []).some((a) => /\.pdf$/i.test(a.name)) ||
    /\b(invoice|receipt|amount paid)\b/.test(text)
  )
    return "finance";
  if (
    /unsubscribe|newsletter|webinar/.test(text) ||
    (email.links ?? []).some((l) => /unsubscribe/i.test(l.url))
  )
    return "promotions";
  const from = domainOf(email.from ?? "");
  if (
    (from === DOMAIN || from === "github.com") &&
    /\?|could you|can you|review|let me know|sign-off/.test(text)
  )
    return "reply";
  return "read_later";
}

function rule(request: Request): Answers {
  const email = asEmail(request.state);
  const suspect = suspicion(email);
  const answers: Answers = {};
  if (request.questions.phishing)
    answers.phishing = {
      type: "noul",
      noul:
        suspect >= 4 ? 0.95 : suspect >= 2 ? 0.8 : suspect === 1 ? 0.3 : 0.05,
    };
  if (request.questions.route?.type === "choice") {
    const keys = Object.keys(request.questions.route.criteria);
    const choice = route(email, suspect);
    answers.route = {
      type: "choice",
      choice,
      probabilities: Object.fromEntries(
        keys.map((k) => [k, k === choice ? 1 : 0]),
      ),
    };
  }
  return answers;
}

export const inbox = textDungeon({
  id: "inbox",
  title: "Inbox",
  description:
    "A finance lead's mail: phishing, fraud, and the genuine article, in four languages and in long digests. Known answers, scored per email.",
  levels: LEVELS,
  state: (c: TextCase) => c.input,
  rule,
  summary: (c: TextCase) => {
    const email = c.input as unknown as Email;
    const subject =
      email.subject.length > 48
        ? `${email.subject.slice(0, 47)}…`
        : email.subject;
    return `${domainOf(email.from)} "${subject}"`;
  },
});
