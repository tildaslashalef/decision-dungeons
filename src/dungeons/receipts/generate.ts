// Receipts' cases: seeded expense receipts, each kept as data and as the
// printed slip a picture is rendered from (`TextCase.source`). Every label
// follows from how the receipt was built: its total against its category's
// limit, its date against the trip, and whether a line is alcohol. Pure:
// the browser imports the types.

import { hash, pick, type Rng, seeded } from "../../lib/random.ts";
import type { TextCase } from "../text/cases.ts";
import { between, chance, shuffle } from "../text/vocab.ts";

export const RECEIPTS_GENERATOR = "receipts@1";

export type Category = "meals" | "taxi" | "lodging" | "supplies";
export type Currency = "USD" | "EUR" | "GBP";

/** The most a receipt of each kind may total, in its own currency. */
export const LIMITS: Record<Category, number> = {
  meals: 75,
  taxi: 60,
  lodging: 220,
  supplies: 150,
};
/** The trip a claim covers, inclusive. */
export const TRIP = { from: "2026-09-01", to: "2026-09-30" };

export const SYMBOLS: Record<Currency, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
};

export interface ReceiptLine {
  item: string;
  qty: number;
  /** The line's amount, quantity included. */
  amount: number;
}

/** A receipt as data: what the text levels show and the rule reads. */
export interface Receipt {
  merchant: string;
  address: string;
  date: string;
  time: string;
  currency: Currency;
  items: ReceiptLine[];
  subtotal: number;
  tax_label: string;
  tax: number;
  tip?: number;
  total: number;
  payment: string;
}

/** A case's input: the receipt and the four totals the total question offers. */
export interface ReceiptInput {
  receipt: Receipt;
  total_options: string[];
}

/** Drinks with alcohol, by name; anything else on a receipt has none. */
export const ALCOHOL = [
  "House Red 175ml",
  "Pinot Grigio (glass)",
  "IPA Pint",
  "Gin & Tonic",
  "Prosecco",
  "Minibar: Beer",
  "Minibar: Wine",
];

const FOOD = [
  "Grilled Salmon",
  "Caesar Salad",
  "Club Sandwich",
  "Margherita Pizza",
  "Chicken Curry",
  "Soup of the Day",
  "Fish & Chips",
  "Veggie Burger",
  "Steak Frites",
];
/** Soft drinks, two of them named like beer. */
const SOFT = [
  "Sparkling Water",
  "Espresso",
  "Lemonade",
  "Ginger Beer",
  "Root Beer",
  "Iced Tea",
];
const SUPPLIES = [
  "A4 Copy Paper (500)",
  "Toner Cartridge",
  "Notebooks (5-pack)",
  "Gel Pens (12)",
  "Sticky Notes",
  "USB-C Cable",
  "Binder Clips",
];

const MERCHANTS: Record<Category, string[]> = {
  meals: [
    "Harbor Grill",
    "Blue Anchor Bistro",
    "Saltline Kitchen",
    "The Quay Cafe",
  ],
  taxi: ["Metro Cab Co.", "Bluebird Taxi", "CityLine Cars"],
  lodging: ["Pier Nine Hotel", "Dockside Inn", "The Lantern House Hotel"],
  supplies: ["Northgate Office Supply", "Paper & Pin", "Deskworks"],
};

const PLACES: Record<Currency, string[]> = {
  USD: ["214 Alaskan Way, Seattle, WA", "88 Atlantic Ave, Boston, MA"],
  EUR: ["Wilhelminakade 12, Rotterdam", "Am Sandtorkai 41, Hamburg"],
  GBP: ["7 Wapping Lane, London", "19 Wharf Street, Leeds"],
};

const TAX: Record<Currency, { label: string; rate: number }> = {
  USD: { label: "Sales tax 8.5%", rate: 0.085 },
  EUR: { label: "VAT 9%", rate: 0.09 },
  GBP: { label: "VAT 20%", rate: 0.2 },
};

/** What breaks the policy, if anything. */
type Fault = "none" | "over" | "alcohol" | "date";

const cents = (amount: number) => Math.round(amount * 100);
const units = (c: number) => c / 100;

/** An amount as printed: the currency's symbol and two decimals. */
export function printed(amount: number, currency: Currency): string {
  return `${SYMBOLS[currency]}${amount.toFixed(2)}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
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

function receiptDate(rng: Rng, inTrip: boolean): string {
  if (inTrip) return `2026-09-${pad(between(rng, 1, 30))}`;
  return chance(rng, 0.5)
    ? `2026-08-${pad(between(rng, 24, 31))}`
    : `2026-10-${pad(between(rng, 1, 7))}`;
}

/** Splits `total` cents over `n` lines, none under a dollar. */
function split(rng: Rng, total: number, n: number): number[] {
  if (n <= 0) return [];
  const weights = Array.from({ length: n }, () => 0.4 + rng());
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w) =>
    Math.max(100, Math.round((total * w) / sum)),
  );
  const last = total - parts.slice(0, -1).reduce((a, b) => a + b, 0);
  parts[n - 1] = last;
  return parts;
}

function lines(
  rng: Rng,
  category: Category,
  subtotal: number,
  alcohol: boolean,
): ReceiptLine[] {
  let names: string[];
  if (category === "taxi") {
    const km = (between(rng, 40, 380) / 10).toFixed(1);
    names = [`Fare (${km} km)`];
    if (chance(rng, 0.4)) names.push("Airport surcharge");
    if (chance(rng, 0.3)) names.push("Toll");
  } else if (category === "lodging") {
    names = ["Room, 1 night"];
    if (chance(rng, 0.5)) names.push("Breakfast");
    if (chance(rng, 0.3)) names.push("Laundry");
    if (alcohol) names.push(pick(rng, ALCOHOL.slice(5)));
  } else if (category === "supplies") {
    names = shuffle(rng, SUPPLIES).slice(0, between(rng, 2, 5));
  } else {
    names = [
      ...shuffle(rng, FOOD).slice(0, between(rng, 1, 3)),
      ...shuffle(rng, SOFT).slice(0, between(rng, 1, 2)),
    ];
    if (alcohol) names.push(pick(rng, ALCOHOL.slice(0, 5)));
  }
  const amounts =
    category === "lodging"
      ? // The room is most of the bill.
        (() => {
          const room =
            names.length === 1 ? subtotal : Math.round(subtotal * 0.75);
          return [room, ...split(rng, subtotal - room, names.length - 1)].slice(
            0,
            names.length,
          );
        })()
      : split(rng, subtotal, names.length);
  return names.map((item, i) => {
    const amount = amounts[i] as number;
    const qty =
      category !== "taxi" && i > 0 && amount % 2 === 0 && chance(rng, 0.25)
        ? 2
        : 1;
    return { item, qty, amount: units(amount) };
  });
}

interface Built {
  receipt: Receipt;
  category: Category;
  approve: boolean;
  why: string;
}

function build(rng: Rng): Built {
  const fault = pick<Fault>(rng, [
    "none",
    "none",
    "none",
    "none",
    "over",
    "over",
    "alcohol",
    "alcohol",
    "date",
  ]);
  const category: Category =
    fault === "alcohol"
      ? pick(rng, ["meals", "meals", "lodging"] as const)
      : pick(rng, ["meals", "meals", "taxi", "lodging", "supplies"] as const);
  const currency = pick(rng, ["USD", "USD", "EUR", "GBP"] as const);
  const limit = cents(LIMITS[category]);
  // Within: often just under the limit; over: just past it.
  const target =
    fault === "over"
      ? Math.round(limit * (1.01 + rng() * 0.17)) + 100
      : chance(rng, 0.5)
        ? Math.round(limit * (0.88 + rng() * 0.11)) - 60
        : Math.round(limit * (0.45 + rng() * 0.4));
  const tax = TAX[currency];
  const taxed = category !== "taxi";
  const tipRate =
    (category === "meals" && chance(rng, 0.7)) ||
    (category === "taxi" && chance(rng, 0.6))
      ? pick(rng, [0.1, 0.12, 0.15, 0.18, 0.2])
      : 0;
  const subtotal = Math.round(target / (1 + (taxed ? tax.rate : 0) + tipRate));
  const taxCents = taxed ? Math.round(subtotal * tax.rate) : 0;
  const tipCents = Math.round(subtotal * tipRate);
  const total = subtotal + taxCents + tipCents;
  const date = receiptDate(rng, fault !== "date");
  const receipt: Receipt = {
    merchant: pick(rng, MERCHANTS[category]),
    address: pick(rng, PLACES[currency]),
    date,
    time: `${pad(between(rng, 7, 22))}:${pad(between(rng, 0, 59))}`,
    currency,
    items: lines(rng, category, subtotal, fault === "alcohol"),
    subtotal: units(subtotal),
    tax_label: taxed ? tax.label : "No tax",
    tax: units(taxCents),
    ...(tipCents ? { tip: units(tipCents) } : {}),
    total: units(total),
    payment: `${pick(rng, ["VISA", "Mastercard", "AMEX"])} •••• ${between(rng, 1000, 9999)}`,
  };
  const over = total > limit;
  const outside = date < TRIP.from || date > TRIP.to;
  const drink = receipt.items.find((l) => ALCOHOL.includes(l.item));
  const approve = !over && !outside && !drink;
  const why = over
    ? `${category} total ${printed(receipt.total, currency)} is over the ${printed(LIMITS[category], currency)} limit`
    : outside
      ? `dated ${date}, outside the trip`
      : drink
        ? `${drink.item} is alcohol`
        : `${category}, ${printed(receipt.total, currency)} within the ${printed(LIMITS[category], currency)} limit, in the trip, no alcohol`;
  return { receipt, category, approve, why };
}

/** Four distinct printed totals, the true one among them, smallest first. */
function totalOptions(rng: Rng, r: Receipt): string[] {
  const total = cents(r.total);
  const digits = String(total);
  // The dollars' last two digits swapped, a common misread.
  const swapped =
    digits.length >= 4
      ? Number(
          digits.slice(0, -4) +
            (digits.at(-3) ?? "") +
            (digits.at(-4) ?? "") +
            digits.slice(-2),
        )
      : total + 900;
  const candidates = [
    cents(r.subtotal),
    cents(r.subtotal) + cents(r.tax),
    swapped,
    total + cents(r.tax),
  ];
  const chosen = new Set<number>([total]);
  for (const c of shuffle(rng, candidates))
    if (chosen.size < 4 && c > 0 && c !== total) chosen.add(c);
  while (chosen.size < 4) chosen.add(total + between(rng, 1, 9) * 100);
  return [...chosen]
    .sort((a, b) => a - b)
    .map((c) => printed(units(c), r.currency));
}

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The printed slip, as a page whose `#page` element is the picture. */
export function slip(r: Receipt): string {
  const money = (amount: number) => escapeHtml(printed(amount, r.currency));
  const row = (label: string, amount: number, cls = "") =>
    `<tr class="${cls}"><td>${escapeHtml(label)}</td><td class="r">${money(amount)}</td></tr>`;
  const [y, m, d] = r.date.split("-").map(Number) as [number, number, number];
  const month = MONTHS[m - 1] ?? "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#ffffff}
#page{box-sizing:border-box;width:340px;padding:22px 22px 26px;background:#fdfcf8;color:#1d1d1f;font:14px/1.45 Menlo,"DejaVu Sans Mono",monospace}
h1{margin:0 0 2px;font-size:18px;text-align:center;letter-spacing:.04em}
.c{text-align:center}.muted{color:#55565a}
.rule{margin:10px 0;border-top:1px dashed #6b6c70}
table{width:100%;border-collapse:collapse}td{padding:1px 0;vertical-align:top}
td.r{padding-left:10px;text-align:right;white-space:nowrap}
.total td{padding-top:5px;font-size:17px;font-weight:700}
</style></head><body><div id="page">
<h1>${escapeHtml(r.merchant.toUpperCase())}</h1>
<div class="c muted">${escapeHtml(r.address)}</div>
<div class="rule"></div>
<div>${month} ${d}, ${y}&nbsp;&nbsp;${escapeHtml(r.time)}</div>
<div class="rule"></div>
<table>${r.items.map((l) => row(l.qty > 1 ? `${l.qty} x ${l.item}` : l.item, l.amount)).join("")}</table>
<div class="rule"></div>
<table>${row("Subtotal", r.subtotal)}${row(r.tax_label, r.tax)}${r.tip !== undefined ? row("Tip", r.tip) : ""}${row("TOTAL", r.total, "total")}</table>
<div class="rule"></div>
<div>${escapeHtml(r.payment)}</div>
<div class="c muted" style="margin-top:12px">Thank you!</div>
</div></body></html>`;
}

/** Questions answered by each level's cases. */
export const RECEIPTS_TRUTH: Record<
  string,
  ("approve" | "total" | "currency" | "category")[]
> = {
  "policy-text": ["approve"],
  total: ["total"],
  "all-questions": ["approve", "total", "currency", "category"],
};

export function receiptCases(
  level: string,
  count: number,
  seed: number,
): TextCase[] {
  const asks = RECEIPTS_TRUTH[level];
  if (!asks) throw new Error(`receipts has no level ${level}`);
  const rng = seeded(hash(`receipts:${level}`, seed));
  return Array.from({ length: count }, (_, index) => {
    const built = build(rng);
    const input: ReceiptInput = {
      receipt: built.receipt,
      total_options: totalOptions(rng, built.receipt),
    };
    const truth: TextCase["truth"] = {};
    for (const q of asks)
      truth[q] =
        q === "approve"
          ? built.approve
          : q === "total"
            ? printed(built.receipt.total, built.receipt.currency)
            : q === "currency"
              ? built.receipt.currency
              : built.category;
    return {
      id: `${level}-${String(index + 1).padStart(4, "0")}`,
      level,
      lang: "en",
      input: input as unknown as TextCase["input"],
      truth,
      why: built.why,
      source: { html: slip(built.receipt), width: 340 },
    };
  });
}
