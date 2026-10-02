// Seeded generator of Inbox cases: realistic mail to Harborline's finance
// operations lead, each labelled by how it was built. A phishing template
// always carries a deceptive sender, link, attachment, or request; a
// genuine one never does, however urgent it sounds. Server-side only in
// practice (the seed script), but pure.

import { hash, pick, type Rng, seeded } from "../../lib/random.ts";
import type { TextCase } from "../text/cases.ts";
import {
  BRANDS,
  between,
  CEO,
  CFO,
  COLLEAGUES,
  chance,
  DOMAIN,
  fill,
  ME,
  mailDate,
  money,
  VENDORS,
} from "../text/vocab.ts";
import { LONG_PARAGRAPHS, TRANSLATED } from "./text.ts";

export const INBOX_GENERATOR = "inbox@2";

/** Where a person would file it; `report_phishing` is any fraud attempt. */
export type Route =
  | "reply"
  | "read_later"
  | "finance"
  | "promotions"
  | "report_phishing";

export interface Email {
  from: string;
  reply_to?: string;
  to: string;
  date: string;
  subject: string;
  /** What the receiving server recorded; a lookalike domain passes its own checks. */
  authentication: { spf: string; dkim: string; dmarc: string };
  body: string;
  links?: { text: string; url: string }[];
  attachments?: { name: string; size_kb: number }[];
}

interface Built {
  email: Email;
  phishing: boolean;
  route: Route;
  why: string;
}

const pass = { spf: "pass", dkim: "pass", dmarc: "pass" };
const ref = (rng: Rng, prefix: string) =>
  `${prefix}-${between(rng, 1000, 9899)}`;
const amount = (rng: Rng, low: number, high: number) =>
  Math.round((low + rng() * (high - low)) * 100) / 100;

function mail(
  rng: Rng,
  fields: Omit<Email, "to" | "date" | "authentication"> & {
    authentication?: Email["authentication"];
  },
): Email {
  // Header order, as a mail client shows it.
  const { from, reply_to, subject, authentication, ...rest } = fields;
  return {
    from,
    ...(reply_to ? { reply_to } : {}),
    to: ME.email,
    date: mailDate(rng),
    subject,
    authentication: authentication ?? pass,
    ...rest,
  };
}

// Phishing, in English.

function credentialHarvest(rng: Rng): Built {
  const brand = pick(
    rng,
    BRANDS.filter((b) => b.name !== "DHL"),
  );
  const fake = pick(rng, brand.lookalikes);
  const lure = pick(rng, [
    {
      subject: `Action required: your password expires in 24 hours`,
      body: `Hello ${ME.first},\n\nThe password for ${ME.email} is set to expire in 24 hours. To avoid losing access to email, Teams, and shared files, keep your current password by confirming your account below.\n\nThis is an automated message from the ${brand.name} account team.`,
      cta: "Keep current password",
    },
    {
      subject: `${between(rng, 3, 9)} messages are held in quarantine`,
      body: `You have messages that were not delivered to your inbox and are being held for review. Messages in quarantine are deleted after 3 days.\n\nReview and release your messages now.`,
      cta: "Review messages",
    },
    {
      subject: `Unusual sign-in activity on your ${brand.name} account`,
      body: `We detected a sign-in attempt from Lagos, Nigeria (IP 102.89.${between(rng, 2, 250)}.${between(rng, 2, 250)}). If this wasn't you, secure your account immediately or it will be temporarily suspended.`,
      cta: "Secure my account",
    },
    {
      subject: `${pick(rng, COLLEAGUES).name} shared "Q3 Payroll Adjustments.xlsx" with you`,
      body: `A file has been shared with you. Sign in with your work account to view the document.\n\nThis link will expire in 48 hours.`,
      cta: "Open document",
    },
  ]);
  const url = `https://${fake}/${pick(rng, ["auth", "login", "secure", "verify"])}/${between(rng, 10000, 99999)}?u=${encodeURIComponent(ME.email)}`;
  return {
    email: mail(rng, {
      from: `${brand.name} <${pick(rng, ["no-reply", "security", "account-team"])}@${fake}>`,
      subject: lure.subject,
      body: `${lure.body}\n\n${lure.cta}: ${brand.site}`,
      links: [{ text: `https://${brand.site}`, url }],
    }),
    phishing: true,
    route: "report_phishing",
    why: `the sender and the link use ${fake}, a lookalike of ${brand.name}; the link text shows ${brand.site}`,
  };
}

function giftCards(rng: Rng): Built {
  const freemail = pick(rng, ["gmail.com", "outlook.com", "proton.me"]);
  const exec = pick(rng, [CEO, CFO]);
  const opener = pick(rng, [
    `Are you at your desk? I need a quick favor handled discreetly.`,
    `I'm stuck in back-to-back meetings with the board and can't take calls. Need you to take care of something for me today.`,
    `Quick one — are you available? I need this done before end of day.`,
  ]);
  const count = pick(rng, [5, 6, 8, 10]);
  const value = pick(rng, [100, 200, 250, 500]);
  return {
    email: mail(rng, {
      from: `${exec.name} <${exec.first.toLowerCase()}.${exec.name.split(" ")[1]?.toLowerCase()}.ceo@${freemail}>`,
      subject: pick(rng, [
        "Quick favor",
        "Are you available?",
        "Urgent request",
        "Confidential",
      ]),
      body: `${ME.first},\n\n${opener} We're sending appreciation gifts to a few key clients and I need ${count} Apple gift cards at ${money(value)} each. Please buy them, scratch the backs, and email me photos of the codes. I'll make sure you're reimbursed this week.\n\nPlease keep this between us for now, it's a surprise.\n\n${exec.first}\nSent from my iPhone`,
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    }),
    phishing: true,
    route: "report_phishing",
    why: `${exec.title} impersonated from a ${freemail} address, asking for gift card codes in secret`,
  };
}

function bankChange(rng: Rng): Built {
  const vendor = pick(rng, VENDORS);
  const invoice = ref(rng, "INV");
  return {
    email: mail(rng, {
      from: `${vendor.contact} <${vendor.contact.split(" ")[0]?.toLowerCase()}@${vendor.lookalike}>`,
      reply_to: `${vendor.contact.toLowerCase().replace(" ", ".")}@${pick(rng, ["gmail.com", "outlook.com"])}`,
      subject: `Updated remittance details — ${invoice}`,
      body: `Hi ${ME.first},\n\nHope you're well. Please note that ${vendor.name} has moved our banking to a new provider following our annual audit. Effective immediately, all payments should be sent to the account below; our previous account will be closed at the end of the week.\n\nBank: ${pick(rng, ["Metro Commerce Bank", "First Harbor Trust", "Pacific Union Bank"])}\nAccount name: ${vendor.name} LLC\nRouting: 0${between(rng, 10000000, 99999999)}\nAccount: ${between(rng, 100000000, 999999999)}\n\nCould you update this before releasing payment for ${invoice} (${money(amount(rng, 8000, 48000))})? Please confirm once done. For speed, reply to this email rather than calling — I'm travelling this week.\n\nBest regards,\n${vendor.contact}\nAccounts Receivable, ${vendor.name}`,
    }),
    phishing: true,
    route: "report_phishing",
    why: `bank details change from ${vendor.lookalike} (not ${vendor.domain}), replies diverted to a free mailbox`,
  };
}

function maliciousInvoice(rng: Rng): Built {
  const vendor = pick(rng, VENDORS);
  const invoice = ref(rng, "INV");
  const ext = pick(rng, [".html", ".htm", ".zip", ".iso", ".pdf.html"]);
  return {
    email: mail(rng, {
      from: `${vendor.name} Billing <billing@${vendor.lookalike}>`,
      subject: pick(rng, [
        `Overdue invoice ${invoice} — final notice`,
        `Remittance advice ${invoice}`,
        `Invoice ${invoice} attached`,
      ]),
      body: `Dear customer,\n\nPlease find attached invoice ${invoice}, now ${between(rng, 15, 45)} days past due. To avoid service interruption and late fees, open the attached document and complete payment today.\n\nKind regards,\nBilling Department`,
      attachments: [
        { name: `${invoice}${ext}`, size_kb: between(rng, 3, 900) },
      ],
    }),
    phishing: true,
    route: "report_phishing",
    why: `"invoice" attachment is ${ext}, not a document, from the lookalike ${vendor.lookalike}`,
  };
}

function payroll(rng: Rng): Built {
  const fake = pick(rng, [
    `${DOMAIN.replace(".io", "")}-payroll.com`,
    `harborline-hr.net`,
    `harborline.workday-portal.com`,
  ]);
  return {
    email: mail(rng, {
      from: `People Operations <payroll@${fake}>`,
      subject: `Confirm your direct deposit before payroll closes`,
      body: `Hi ${ME.first},\n\nWe're migrating to a new payroll provider this cycle. To make sure your ${pick(rng, ["September 30", "October 1"])} salary is deposited on time, confirm your bank details in the new portal by 5 PM today. Employees who don't confirm will be paid by paper check, which can take up to 10 business days.\n\nThank you,\nPeople Operations`,
      links: [
        {
          text: "Confirm direct deposit",
          url: `https://${fake}/sso/confirm?id=${between(rng, 100000, 999999)}`,
        },
      ],
    }),
    phishing: true,
    route: "report_phishing",
    why: `payroll mail from ${fake}, outside ${DOMAIN}, asking for bank details under a deadline`,
  };
}

function deliveryFee(rng: Rng): Built {
  const dhl = BRANDS.find((b) => b.name === "DHL") as (typeof BRANDS)[number];
  const fake = pick(rng, dhl.lookalikes);
  const fee = pick(rng, ["1.99", "2.49", "3.20"]);
  return {
    email: mail(rng, {
      from: `DHL Express <notice@${fake}>`,
      subject: `Your parcel is on hold: customs fee unpaid`,
      body: `Your shipment ${between(rng, 1000000000, 9999999999)} could not be delivered because an import fee of $${fee} is outstanding. Pay within 48 hours or the parcel will be returned to the sender.`,
      links: [
        {
          text: "Pay and schedule delivery",
          url: `https://${fake}/pay?ref=${between(rng, 10000, 99999)}`,
        },
      ],
    }),
    phishing: true,
    route: "report_phishing",
    why: `a small "customs fee" demanded through ${fake}, not dhl.com`,
  };
}

function itHelpdesk(rng: Rng): Built {
  const fake = pick(rng, [
    "harborline-helpdesk.com",
    "harborline-it.support",
    "it-harborline.com",
  ]);
  return {
    email: mail(rng, {
      from: `IT Service Desk <servicedesk@${fake}>`,
      subject: pick(rng, [
        "Mailbox storage 98% full",
        "Mandatory MFA re-enrollment",
      ]),
      body: `Hello ${ME.first},\n\nOur records show your account must be re-validated after this weekend's security upgrade. Accounts that are not re-validated within 24 hours will be locked and incoming mail will bounce.\n\nRe-validate here using your current username and password.\n\nIT Service Desk`,
      links: [
        {
          text: `https://helpdesk.${DOMAIN}`,
          url: `https://${fake}/revalidate`,
        },
      ],
    }),
    phishing: true,
    route: "report_phishing",
    why: `IT mail from ${fake}, not ${DOMAIN}, link text and target differ, asks for the password`,
  };
}

// Genuine mail, in English.

function genuineSecurity(rng: Rng): Built {
  const brand = pick(
    rng,
    BRANDS.filter((b) => b.name === "Microsoft" || b.name === "Dropbox"),
  );
  return {
    email: mail(rng, {
      from: `${brand.name} account team <${brand.sender}>`,
      subject: `New sign-in to your ${brand.name} account`,
      body: `We noticed a new sign-in to your ${brand.name} account ${ME.email}.\n\nWhen: ${mailDate(rng)}\nDevice: ${pick(rng, ["Chrome on macOS", "Safari on iPhone", "Edge on Windows"])}\nLocation: ${pick(rng, ["Seattle, WA, United States", "Portland, OR, United States"])}\n\nIf this was you, you can ignore this message. If not, review your recent activity at ${brand.site}. We'll never ask for your password by email.`,
      links: [
        {
          text: "Review recent activity",
          url: `https://${brand.site}/security`,
        },
      ],
    }),
    phishing: false,
    route: "read_later",
    why: `${brand.name}'s real sender and site, no request for credentials`,
  };
}

function colleagueRequest(rng: Rng): Built {
  const from = pick(rng, COLLEAGUES);
  const ask = pick(rng, [
    {
      subject: "Q3 freight accrual — can you check my numbers?",
      body: `Hi ${ME.first},\n\nBefore I post the Q3 freight accrual, could you sanity-check the Northwind and Cascade lines? I'm showing ${money(amount(rng, 40000, 120000))} unbilled for September, which feels high. The workbook is in the close folder.\n\nThursday morning works if you'd rather walk through it together.\n\nThanks,\n${from.first}`,
      link: `https://${DOMAIN.replace(".io", "")}.sharepoint.com/sites/finance/close/Q3-accruals.xlsx`,
    },
    {
      subject: "Vendor onboarding for Bluewater — need your sign-off",
      body: `Hi ${ME.first},\n\nBluewater sent their W-9 and banking letter through the vendor portal. Procurement has reviewed it; could you approve the vendor record in NetSuite when you get a chance? Ideally before Friday's payment run.\n\n${from.first}`,
      link: `https://${DOMAIN.replace(".io", "")}.app.netsuite.com/app/common/entity/vendor.nl?id=${between(rng, 1000, 9999)}`,
    },
    {
      subject: "Agenda for Monday's budget review",
      body: `Morning ${ME.first},\n\nI've drafted the agenda for Monday's budget review. Can you add ten minutes for the fuel card reconciliation? Let me know by tomorrow so I can send it out.\n\nBest,\n${from.first}`,
      link: `https://docs.google.com/document/d/${between(rng, 100000, 999999)}abcXyZ/edit`,
    },
  ]);
  return {
    email: mail(rng, {
      from: `${from.name} <${from.email}>`,
      subject: ask.subject,
      body: ask.body,
      links: [{ text: "link", url: ask.link }],
    }),
    phishing: false,
    route: "reply",
    why: `a colleague at ${DOMAIN} asking for a review or decision, links to company tools`,
  };
}

function vendorInvoice(rng: Rng): Built {
  const vendor = pick(rng, VENDORS);
  const invoice = ref(rng, "INV");
  return {
    email: mail(rng, {
      from: `${vendor.name} Accounts <ar@${vendor.domain}>`,
      subject: `Invoice ${invoice} from ${vendor.name}`,
      body: `Hello,\n\nPlease find attached invoice ${invoice} for ${vendor.service} in ${pick(rng, ["August", "September"])} 2026.\n\nAmount due: ${money(amount(rng, 1200, 36000))}\nTerms: Net 30\nPO: PO-${between(rng, 20000, 29999)}\n\nPayment details are unchanged from previous invoices. Questions? Reply to this email or call ${vendor.contact} at (206) 555-0${between(rng, 100, 199)}.\n\nThank you for your business,\n${vendor.name}`,
      attachments: [{ name: `${invoice}.pdf`, size_kb: between(rng, 60, 400) }],
    }),
    phishing: false,
    route: "finance",
    why: `invoice from ${vendor.domain}, the vendor's real domain, PDF attached, no change of bank`,
  };
}

function receipt(rng: Rng): Built {
  const service = pick(rng, [
    {
      name: "Figma",
      from: "billing@figma.com",
      item: "Organization plan, 12 editors",
    },
    {
      name: "Slack",
      from: "feedback@slack.com",
      item: "Business+ plan, 210 members",
    },
    {
      name: "Notion",
      from: "team@makenotion.com",
      item: "Business plan, 40 members",
    },
  ]);
  return {
    email: mail(rng, {
      from: `${service.name} <${service.from}>`,
      subject: `Your ${service.name} receipt #${between(rng, 100000, 999999)}`,
      body: `Thanks for your payment.\n\n${service.item}\nAmount paid: ${money(amount(rng, 300, 9000))}\nPayment method: Visa ending ${between(rng, 1000, 9999)}\n\nYou can download invoices from your billing settings at any time.`,
    }),
    phishing: false,
    route: "finance",
    why: `a receipt from ${service.name}'s own domain, nothing to click or pay`,
  };
}

function newsletter(rng: Rng): Built {
  const sender = pick(rng, [
    {
      name: "FreightWaves",
      from: "newsletter@freightwaves.com",
      topic: "spot rates and capacity",
    },
    { name: "Ramp", from: "hello@ramp.com", topic: "spend management" },
    { name: "Gusto", from: "news@gusto.com", topic: "payroll compliance" },
  ]);
  return {
    email: mail(rng, {
      from: `${sender.name} <${sender.from}>`,
      subject: pick(rng, [
        `This week in ${sender.topic}`,
        `${between(rng, 3, 7)} ideas to close the books faster`,
        `Webinar: what's changing in ${sender.topic} for Q4`,
      ]),
      body: `Hi ${ME.first},\n\nHere's what we're reading this week on ${sender.topic}: a look at Q4 forecasts, a customer story from a mid-size 3PL, and a checklist for year-end.\n\nSave your seat for Thursday's live session.\n\nYou're receiving this because you subscribed. Unsubscribe or manage preferences at any time.`,
      links: [
        {
          text: "Read more",
          url: `https://${sender.from.split("@")[1]}/blog?utm_source=newsletter`,
        },
        {
          text: "Unsubscribe",
          url: `https://${sender.from.split("@")[1]}/unsubscribe`,
        },
      ],
    }),
    phishing: false,
    route: "promotions",
    why: `a subscribed newsletter from ${sender.name}'s own domain`,
  };
}

function internalNotice(rng: Rng): Built {
  const notice = pick(rng, [
    {
      from: `IT Systems <it@${DOMAIN}>`,
      subject: "Planned Okta maintenance this Saturday 22:00–23:00",
      body: `Hi all,\n\nOkta will be unavailable on Saturday from 22:00 to 23:00 Pacific for a scheduled upgrade. You don't need to do anything; existing sessions keep working. No one from IT will ask for your password.\n\nLuca, IT Systems`,
      url: `https://status.${DOMAIN}`,
    },
    {
      from: `People Operations <people@${DOMAIN}>`,
      subject: "Reminder: open enrollment closes Friday",
      body: `Hi ${ME.first},\n\nOpen enrollment for 2027 benefits closes this Friday. Review your elections in BambooHR; if you change nothing, your current plans roll over.\n\nSofia, People Operations`,
      url: `https://${DOMAIN.replace(".io", "")}.bamboohr.com/benefits`,
    },
  ]);
  return {
    email: mail(rng, {
      from: notice.from,
      subject: notice.subject,
      body: notice.body,
      links: [{ text: "details", url: notice.url }],
    }),
    phishing: false,
    route: "read_later",
    why: `an internal notice from ${DOMAIN} linking to company systems, asking for nothing`,
  };
}

function github(rng: Rng): Built {
  const n = between(rng, 120, 480);
  return {
    email: mail(rng, {
      from: `${pick(rng, COLLEAGUES).first} <notifications@github.com>`,
      subject: `[harborline/finance-etl] Fix FX rounding in accrual export (PR #${n})`,
      body: `@mlindqvist, ${pick(rng, COLLEAGUES).first} requested your review on this pull request.\n\nRounds EUR and GBP amounts to cents before the accrual export, matching NetSuite.\n\nView it on GitHub or reply to this email directly.`,
      links: [
        {
          text: `PR #${n}`,
          url: `https://github.com/harborline/finance-etl/pull/${n}`,
        },
      ],
    }),
    phishing: false,
    route: "reply",
    why: "a GitHub review request from github.com about a company repository",
  };
}

const PHISHING = [
  credentialHarvest,
  credentialHarvest,
  giftCards,
  bankChange,
  maliciousInvoice,
  payroll,
  deliveryFee,
  itHelpdesk,
];
const GENUINE = [
  genuineSecurity,
  colleagueRequest,
  colleagueRequest,
  vendorInvoice,
  receipt,
  newsletter,
  internalNotice,
  github,
];

// Other languages: the same kinds of mail, written by hand per language.

function translated(rng: Rng, lang: string): Built {
  const set = TRANSLATED[lang];
  if (!set) throw new Error(`no inbox templates in ${lang}`);
  const phishing = chance(rng, 0.5);
  const t = pick(rng, phishing ? set.phishing : set.genuine);
  const vendor = pick(rng, VENDORS);
  const brand = BRANDS[0] as (typeof BRANDS)[number];
  const colleague = pick(rng, COLLEAGUES);
  const values: Record<string, string> = {
    me: ME.first,
    exec: CEO.name,
    execFirst: CEO.first,
    colleague: colleague.first,
    colleagueName: colleague.name,
    colleagueEmail: colleague.email,
    vendor: vendor.name,
    contact: vendor.contact,
    invoice: ref(rng, "INV"),
    amount: money(amount(rng, 2000, 40000), "EUR"),
    count: String(pick(rng, [5, 8, 10])),
    iban: `DE${between(rng, 10, 99)} ${between(rng, 1000, 9999)} ${between(rng, 1000, 9999)} ${between(rng, 1000, 9999)} ${between(rng, 1000, 9999)} ${between(rng, 10, 99)}`,
    site: brand.site,
    fake: pick(rng, brand.lookalikes),
    lookalike: vendor.lookalike,
    vendorDomain: vendor.domain,
    freemail: pick(rng, ["gmail.com", "outlook.com"]),
  };
  const f = (text: string) => fill(text, values);
  // Address local parts are lower case, whatever the name.
  const from = f(t.from).replace(
    /<([^@>]+)@/,
    (_, local: string) => `<${local.toLowerCase()}@`,
  );
  return {
    email: mail(rng, {
      from,
      subject: f(t.subject),
      body: f(t.body),
      ...(t.link
        ? { links: [{ text: f(t.linkText ?? t.link), url: f(t.link) }] }
        : {}),
      ...(t.attachment
        ? {
            attachments: [
              { name: f(t.attachment), size_kb: between(rng, 40, 400) },
            ],
          }
        : {}),
    }),
    phishing,
    route: phishing ? "report_phishing" : t.route,
    why: t.why,
  };
}

// Long mail: a digest whose only fraud, when there is one, is a line near
// the end. The links are in the text, as plain-text mail carries them.

function longDigest(rng: Rng): Built {
  const phishing = chance(rng, 0.5);
  const paragraphs = Array.from({ length: between(rng, 14, 22) }, () =>
    pick(rng, LONG_PARAGRAPHS),
  );
  const sender = pick(rng, [
    { name: "Harborline Weekly", from: `weekly@${DOMAIN}` },
    {
      name: "Logistics Finance Forum",
      from: "digest@logisticsfinanceforum.org",
    },
  ]);
  const ending = phishing
    ? `\n\nP.S. Members must re-verify their payout account for the Q4 rebate program by Friday. Sign in with your work email and password at https://${pick(rng, ["harborline-rebates.com", "lff-member-verify.net", "rebate-portal-login.com"])}/verify to keep receiving payments.`
    : `\n\nP.S. The Q4 rebate statements are now in the member area at https://${sender.from.split("@")[1]}/members — nothing to do unless your details changed, in which case email the treasurer.`;
  return {
    email: mail(rng, {
      from: `${sender.name} <${sender.from}>`,
      subject: `${sender.name}: ${pick(rng, ["the week in freight finance", "notes from the quarter", "this month's reading"])}`,
      body: `Hi ${ME.first},\n\n${paragraphs.join("\n\n")}${ending}\n\n— ${sender.name}`,
    }),
    phishing,
    route: phishing
      ? "report_phishing"
      : sender.from.endsWith(DOMAIN)
        ? "read_later"
        : "promotions",
    why: phishing
      ? "a long digest whose last lines ask for a password on an outside site"
      : "a long digest; its only link goes to the sender's own site and asks for nothing",
  };
}

function build(
  level: string,
  rng: Rng,
  index: number,
): { built: Built; lang: string } {
  switch (level) {
    case "phishing":
    case "triage":
    case "all-questions": {
      const phishing =
        level === "phishing"
          ? index % 2 === 0
          : level === "all-questions"
            ? index % 3 === 0
            : chance(rng, 0.25);
      return {
        built: pick(rng, phishing ? PHISHING : GENUINE)(rng),
        lang: "en",
      };
    }
    case "languages": {
      const lang = pick(rng, Object.keys(TRANSLATED));
      return { built: translated(rng, lang), lang };
    }
    case "long":
      return { built: longDigest(rng), lang: "en" };
    default:
      throw new Error(`inbox has no level ${level}`);
  }
}

/** Questions answered by each level's cases. */
export const INBOX_TRUTH: Record<string, ("phishing" | "route")[]> = {
  phishing: ["phishing"],
  triage: ["route"],
  languages: ["phishing"],
  long: ["phishing"],
  "all-questions": ["phishing", "route"],
};

export function inboxCases(
  level: string,
  count: number,
  seed: number,
): TextCase[] {
  const rng = seeded(hash(`inbox:${level}`, seed));
  return Array.from({ length: count }, (_, index) => {
    const { built, lang } = build(level, rng, index);
    const truth: TextCase["truth"] = {};
    for (const q of INBOX_TRUTH[level] ?? [])
      truth[q] = q === "phishing" ? built.phishing : built.route;
    return {
      id: `${level}-${String(index + 1).padStart(4, "0")}`,
      level,
      lang,
      input: built.email as unknown as TextCase["input"],
      truth,
      why: built.why,
    };
  });
}
