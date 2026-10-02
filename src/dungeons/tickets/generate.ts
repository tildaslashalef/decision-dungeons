// Seeded generator of support tickets to Harborline, whose customers ship
// freight with its transport-management software. Each template fixes the
// team that owns the ticket, its urgency, and whether money is asked back;
// the wording, the customer, and the details vary. Pure.

import { hash, pick, type Rng, seeded } from "../../lib/random.ts";
import type { TextCase } from "../text/cases.ts";
import { between, CUSTOMERS, isoAt, money, personName } from "../text/vocab.ts";
import { TICKETS_TRANSLATED } from "./text.ts";

export const TICKETS_GENERATOR = "tickets@1";

export type Team =
  | "billing"
  | "technical"
  | "account_access"
  | "sales"
  | "privacy_security";

/** 0 low, 1 normal, 2 high, 3 critical. */
export type Urgency = 0 | 1 | 2 | 3;

export interface Ticket {
  ticket: string;
  channel: "email" | "chat" | "web form";
  received: string;
  customer: {
    name: string;
    company: string;
    plan: "Starter" | "Growth" | "Enterprise";
    seats: number;
  };
  subject: string;
  message: string;
}

interface Template {
  team: Team;
  urgency: Urgency;
  refund: boolean;
  subject: string;
  message: string;
  why: string;
}

type Slots = Record<string, string>;

function slots(rng: Rng, company: string, first: string): Slots {
  return {
    company,
    first,
    amount: money(between(rng, 180, 9400) + between(rng, 0, 99) / 100),
    invoice: `HL-INV-${between(rng, 20000, 29999)}`,
    loads: String(between(rng, 12, 340)),
    users: String(between(rng, 4, 80)),
    carrier: pick(rng, [
      "Northwind Freight",
      "Swift Lane Carriers",
      "Redwood Haulage",
      "Prairie Express",
    ]),
    since: pick(rng, [
      "6:10 this morning",
      "about an hour ago",
      "since the 9am release",
      "since last night",
    ]),
    erp: pick(rng, [
      "NetSuite",
      "SAP Business One",
      "Microsoft Dynamics",
      "QuickBooks Online",
    ]),
    days: String(between(rng, 2, 9)),
    error: pick(rng, [
      "502 Bad Gateway",
      "Error 500: label service unavailable",
      "timeout after 30000 ms",
      "ERR_RATE_ENGINE_UNREACHABLE",
    ]),
  };
}

const T = (
  team: Team,
  urgency: Urgency,
  refund: boolean,
  subject: string,
  message: string,
  why: string,
): Template => ({ team, urgency, refund, subject, message, why });

/** English templates; slots in braces come from `slots`. */
const TEMPLATES: Template[] = [
  // Billing.
  T(
    "billing",
    2,
    true,
    "Charged twice for September",
    "Hi,\n\nOur card was charged {amount} twice on the 1st for the same invoice ({invoice}). Our controller flagged it this morning and we need the duplicate reversed before our month-end close on Friday. Please refund the second charge.\n\nThanks,\n{first}",
    "a duplicate charge to be refunded before a close deadline",
  ),
  T(
    "billing",
    1,
    false,
    "Invoice shows the wrong PO number",
    "Hello, invoice {invoice} lists PO-11842 but our purchase order for this term is PO-11924. No refund needed, we just need a corrected PDF so AP can process it. Not urgent, any time this week.\n\n{first}",
    "a corrected invoice, explicitly no refund, no deadline pressure",
  ),
  T(
    "billing",
    1,
    true,
    "Credit for last week's downtime?",
    "Hi team, per our Enterprise agreement we're entitled to a service credit when uptime drops below 99.9%. Last Tuesday's label outage lasted about four hours. Can you apply the credit to our next invoice?\n\nBest,\n{first}",
    "an SLA credit, which is money back",
  ),
  T(
    "billing",
    0,
    false,
    "Can we switch to annual billing?",
    "Hi! We're happy with Harborline and finance would like to move from monthly to annual billing at renewal. Is there a discount for paying annually? No rush.\n\n{first}",
    "a billing question with no problem and no deadline",
  ),
  T(
    "billing",
    2,
    true,
    "Disputing this charge",
    "We cancelled our add-on seats in August and were still billed {amount} on invoice {invoice}. I've asked twice in chat with no answer. If this isn't refunded by Monday I'll dispute it with our bank.\n\n{first}",
    "a refund demand with a chargeback threat",
  ),
  T(
    "billing",
    1,
    false,
    "VAT number missing on invoices",
    "Our EU entity needs its VAT number printed on invoices for the auditors. Could you add it to the account? Happy to send it again if needed.\n\n{first}",
    "an invoice detail to fix, nothing to pay back",
  ),
  // Technical.
  T(
    "technical",
    3,
    false,
    "URGENT: no labels printing for any warehouse",
    'Label generation has failed for all of our warehouses {since}. Every attempt returns "{error}". We have {loads} loads waiting at the docks and drivers are leaving without paperwork. Please escalate.\n\n{first}',
    "a full outage of a core flow for every site",
  ),
  T(
    "technical",
    3,
    false,
    "Shipment data disappeared",
    "Hello,\n\nWe noticed this morning that all shipments created between Tuesday and Thursday are gone from the dashboard and from the API. That's {loads} loads with customer references we can't recreate. Please tell us this is recoverable.\n\nRegards,\n{first}",
    "data loss across many records",
  ),
  T(
    "technical",
    2,
    false,
    "Rate quotes failing for one carrier",
    'Since yesterday, rate shopping returns "{error}" for {carrier} only; other carriers quote fine. Our team can still book them by phone, but it\'s slowing dispatch down considerably.\n\n{first}',
    "one integration broken with a manual workaround, slowing a team",
  ),
  T(
    "technical",
    1,
    false,
    "{erp} sync skipped a few invoices",
    "Hi, the nightly {erp} sync skipped three freight invoices last night. Re-running it manually worked, so this is more of a heads-up so you can look at why it happened.\n\n{first}",
    "a bug with a working workaround",
  ),
  T(
    "technical",
    0,
    false,
    "Typo on the tracking page",
    'This is honestly embarrassing. Your customer-facing tracking page says "Estimated delievery". Our customers see that on every shipment. Please fix it.\n\n{first}',
    "a cosmetic typo, however annoyed the writer",
  ),
  T(
    "technical",
    0,
    false,
    "Feature idea: bulk edit pickup windows",
    "Would love a way to change pickup windows for many loads at once. Today we edit them one at a time. Not a problem, just an idea for the roadmap!\n\n{first}",
    "a feature request",
  ),
  T(
    "technical",
    3,
    false,
    "Everything is very slow — can't dispatch",
    "Hi, I don't want to overreact, but the app has been taking over a minute to load any page {since}, for everyone in our company. We have effectively stopped dispatching. Could someone take a look?\n\nThank you,\n{first}",
    "a company-wide stoppage, written calmly",
  ),
  // Account access.
  T(
    "account_access",
    2,
    false,
    "Locked out after MFA reset",
    "I replaced my phone and now the authenticator codes don't work, so I'm locked out. I'm the only dispatcher on shift today and can't book anything until I'm back in.\n\n{first}",
    "a locked-out user who is blocked today",
  ),
  T(
    "account_access",
    3,
    false,
    "SSO broken for our whole company",
    'Since our IT team rotated the SAML certificate this morning, nobody at {company} can sign in through Okta. All {users} users get "invalid signature". We cannot work at all.\n\n{first}',
    "every user locked out",
  ),
  T(
    "account_access",
    1,
    false,
    "Please add two seats for new hires",
    "Hi, two new coordinators start on Monday. Could you add two seats and send invites to the addresses below? We're on the {plan} plan.\n\n{first}",
    "a seat change with a known date",
  ),
  T(
    "account_access",
    0,
    false,
    "How do I change my notification email?",
    "Quick question: where do I change the address notifications go to? I can't find it in settings.\n\n{first}",
    "a how-to question",
  ),
  // Sales.
  T(
    "sales",
    1,
    false,
    "Quote for the yard management module",
    "We'd like pricing for the yard management add-on for three sites, ideally before our budget meeting at the end of next week.\n\n{first}",
    "a quote request for an add-on",
  ),
  T(
    "sales",
    0,
    false,
    "Interested in a demo of the carrier portal",
    "Hello, we've heard good things about the carrier portal. Could someone walk our ops team through it sometime next month?\n\n{first}",
    "a demo request",
  ),
  T(
    "sales",
    2,
    false,
    "Renewal pricing — need an answer by Thursday",
    "Our renewal is due on the 30th and procurement needs final pricing by Thursday to get it approved, or the renewal slips a quarter. Can you send the quote for {users} seats?\n\n{first}",
    "a renewal quote with a hard approval deadline",
  ),
  // Privacy and security.
  T(
    "privacy_security",
    2,
    false,
    "Request to delete a former employee's data",
    "Under GDPR, a former employee of ours has asked us to erase personal data we hold. Please delete the user account and any personal data for j.moreau@{domain} and confirm in writing within the statutory month.\n\n{first}",
    "a data erasure request with a legal deadline",
  ),
  T(
    "privacy_security",
    3,
    false,
    "We think one of our accounts was compromised",
    "One of our users reports shipments being rerouted to an address we don't recognise, and the audit log shows sign-ins from an IP in another country overnight. Please lock the account and help us investigate.\n\n{first}",
    "a likely account compromise with active misuse",
  ),
  T(
    "privacy_security",
    1,
    false,
    "Security questionnaire for our vendor review",
    "Our security team is running the annual vendor review. Could you send your SOC 2 report and fill in the attached questionnaire within three weeks?\n\n{first}",
    "a routine security review",
  ),
];

const REFUND_TEMPLATES = TEMPLATES.filter((t) => t.team === "billing");

function ticket(rng: Rng, t: Template): { input: Ticket; template: Template } {
  const company = pick(rng, CUSTOMERS);
  const person = personName(rng);
  const s = slots(rng, company, person.first);
  const plan = pick(rng, ["Starter", "Growth", "Enterprise"] as const);
  s.plan = plan;
  s.domain = `${company.toLowerCase().replace(/[^a-z]+/g, "")}.com`;
  const fill = (text: string) =>
    text.replace(/\{(\w+)\}/g, (_, k: string) => s[k] ?? k);
  return {
    input: {
      ticket: `HL-${between(rng, 40000, 79999)}`,
      channel: pick(rng, ["email", "chat", "web form"] as const),
      received: isoAt(between(rng, 0, 29) * 86400, between(rng, 21600, 72000)),
      customer: {
        name: `${person.first} ${person.last}`,
        company,
        plan,
        seats:
          plan === "Starter"
            ? between(rng, 3, 10)
            : plan === "Growth"
              ? between(rng, 10, 60)
              : between(rng, 60, 400),
      },
      subject: fill(t.subject),
      message: fill(t.message),
    },
    template: t,
  };
}

export const TICKETS_TRUTH: Record<string, ("team" | "urgency" | "refund")[]> =
  {
    routing: ["team"],
    urgency: ["urgency"],
    refunds: ["refund"],
    languages: ["team"],
  };

export function ticketCases(
  level: string,
  count: number,
  seed: number,
): TextCase[] {
  const rng = seeded(hash(`tickets:${level}`, seed));
  return Array.from({ length: count }, (_, index) => {
    let lang = "en";
    let built: { input: Ticket; template: Template };
    if (level === "languages") {
      lang = pick(rng, Object.keys(TICKETS_TRANSLATED));
      built = ticket(rng, pick(rng, TICKETS_TRANSLATED[lang] as Template[]));
    } else if (level === "refunds") {
      // Half from billing, where refunds and their look-alikes live.
      built = ticket(rng, pick(rng, index % 2 ? REFUND_TEMPLATES : TEMPLATES));
    } else built = ticket(rng, pick(rng, TEMPLATES));
    const { template } = built;
    const truth: TextCase["truth"] = {};
    for (const q of TICKETS_TRUTH[level] ?? [])
      truth[q] =
        q === "team"
          ? template.team
          : q === "urgency"
            ? template.urgency
            : template.refund;
    return {
      id: `${level}-${String(index + 1).padStart(4, "0")}`,
      level,
      lang,
      input: built.input as unknown as TextCase["input"],
      truth,
      why: template.why,
    };
  });
}

export type { Template as TicketTemplate };
