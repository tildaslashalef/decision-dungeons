// The people, companies, and places the text generators draw from, and the
// seeded helpers they share. The world is fictional: Harborline, a
// logistics-software company, its staff, vendors, and customers. Real
// service names appear only where real mail would carry them (a GitHub
// notification, a lookalike of a well-known brand).

import { pick, type Rng } from "../../lib/random.ts";

export const COMPANY = "Harborline";
export const DOMAIN = "harborline.io";
/** The inbox owner. */
export const ME = {
  name: "Maya Lindqvist",
  first: "Maya",
  email: `maya.lindqvist@${DOMAIN}`,
  title: "Finance Operations Lead",
};

export interface Person {
  name: string;
  first: string;
  email: string;
  title: string;
}

const staff = (name: string, title: string): Person => {
  const [first = name, ...rest] = name.split(" ");
  const last = rest
    .join("")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return {
    name,
    first,
    email: `${first.toLowerCase()}.${last}@${DOMAIN}`,
    title,
  };
};

export const CEO = staff("Daniel Okafor", "Chief Executive Officer");
export const CFO = staff("Priya Raman", "Chief Financial Officer");
export const COLLEAGUES: Person[] = [
  staff("Tomás Ferreira", "Senior Accountant"),
  staff("Hannah Becker", "Procurement Manager"),
  staff("Kwame Mensah", "Head of Logistics Partnerships"),
  staff("Aiko Tanaka", "Data Analyst"),
  staff("Luca Romano", "IT Systems Administrator"),
  staff("Sofia Petrova", "People Operations Partner"),
  staff("Omar Haddad", "Revenue Operations Manager"),
  staff("Grace Whitfield", "Controller"),
  staff("Mateo Alvarez", "Customer Success Lead"),
  staff("Nadia Karimi", "Legal Counsel"),
];

export interface Vendor {
  name: string;
  domain: string;
  /** A one-letter-off lookalike an attacker registered. */
  lookalike: string;
  contact: string;
  service: string;
}

export const VENDORS: Vendor[] = [
  {
    name: "Northwind Freight",
    domain: "northwindfreight.com",
    lookalike: "northwlndfreight.com",
    contact: "Elena Marsh",
    service: "linehaul trucking",
  },
  {
    name: "Bluewater Customs Brokerage",
    domain: "bluewatercustoms.com",
    lookalike: "bluewater-customs.co",
    contact: "Raj Patel",
    service: "customs brokerage",
  },
  {
    name: "Cascade Warehousing",
    domain: "cascadewarehousing.com",
    lookalike: "cascadewarehousinq.com",
    contact: "Molly Chen",
    service: "pallet storage",
  },
  {
    name: "Ironbridge Fuel Cards",
    domain: "ironbridgefuel.com",
    lookalike: "ironbridge-fuel.net",
    contact: "Victor Hale",
    service: "fleet fuel cards",
  },
  {
    name: "Summit Office Supply",
    domain: "summitoffice.com",
    lookalike: "summit0ffice.com",
    contact: "Dana Brooks",
    service: "office supplies",
  },
];

export interface Brand {
  name: string;
  /** Where genuine mail comes from and links go. */
  sender: string;
  site: string;
  /** Domains phishers register to imitate it. */
  lookalikes: string[];
}

export const BRANDS: Brand[] = [
  {
    name: "Microsoft",
    sender: "account-security-noreply@accountprotection.microsoft.com",
    site: "account.microsoft.com",
    lookalikes: [
      "microsoft-365-verify.com",
      "login-microsoftonline.co",
      "micros0ft-support.net",
    ],
  },
  {
    name: "DocuSign",
    sender: "dse@docusign.net",
    site: "app.docusign.com",
    lookalikes: ["docusign-review.com", "docusign.envelope-view.net"],
  },
  {
    name: "Okta",
    sender: "noreply@okta.com",
    site: `harborline.okta.com`,
    lookalikes: ["harborline-okta.com", "okta-harborline.net"],
  },
  {
    name: "Dropbox",
    sender: "no-reply@dropbox.com",
    site: "www.dropbox.com",
    lookalikes: ["dropbox-sharedfiles.com", "dropbox.file-access.net"],
  },
  {
    name: "DHL",
    sender: "noreply@dhl.com",
    site: "www.dhl.com",
    lookalikes: ["dhl-parcel-fees.com", "dhl-redelivery.info"],
  },
];

export const CUSTOMERS = [
  "Alder & Finch Outdoor",
  "Meridian Medical Supply",
  "Copperline Foods",
  "Tidewater Building Materials",
  "Orchard Lane Grocers",
  "Pinecrest Auto Parts",
  "Lumen Pharmacy Group",
  "Saltmarsh Brewing Co.",
  "Granite Peak Hardware",
  "Bayview Home Goods",
  "Kestrel Robotics",
  "Harvest Moon Bakeries",
];

export const FIRST_NAMES = [
  "James",
  "Fatima",
  "Wei",
  "Olivia",
  "Diego",
  "Amara",
  "Noah",
  "Ines",
  "Yusuf",
  "Chloe",
  "Arjun",
  "Mei",
  "Lucas",
  "Zainab",
  "Ethan",
  "Leila",
  "Mateus",
  "Freya",
  "Kenji",
  "Isabel",
  "Samuel",
  "Anya",
  "Hassan",
  "Elif",
];
export const LAST_NAMES = [
  "Nguyen",
  "Okonkwo",
  "Schmidt",
  "García",
  "Kowalski",
  "Haddad",
  "Sato",
  "O'Brien",
  "Silva",
  "Andersson",
  "Mehta",
  "Dubois",
  "Rossi",
  "Kim",
  "Abara",
  "Novak",
  "Moreau",
  "Jensen",
  "Costa",
  "Yilmaz",
];

export const between = (rng: Rng, low: number, high: number): number =>
  low + Math.floor(rng() * (high - low + 1));

export const chance = (rng: Rng, p: number): boolean => rng() < p;

/** A shuffled copy. */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export function personName(rng: Rng): { first: string; last: string } {
  return { first: pick(rng, FIRST_NAMES), last: pick(rng, LAST_NAMES) };
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** A date in September 2026, as a mail header prints it; never the clock. */
export function mailDate(rng: Rng): string {
  const day = between(rng, 1, 30);
  // 1 September 2026 is a Tuesday.
  const weekday = DAYS[(day + 0) % 7] as string;
  const hour = between(rng, 6, 20);
  const minute = between(rng, 0, 59);
  return `${weekday}, ${day} ${MONTHS[8]} 2026 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** An ISO timestamp in September 2026 plus `seconds`. */
export function isoAt(base: number, seconds: number): string {
  return new Date(Date.UTC(2026, 8, 1) + (base + seconds) * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

export const money = (amount: number, currency = "USD"): string =>
  currency === "USD"
    ? `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `${amount.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Fills `{name}` slots from `values`. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(
    /\{(\w+)\}/g,
    (_, key: string) => values[key] ?? `{${key}}`,
  );
}
