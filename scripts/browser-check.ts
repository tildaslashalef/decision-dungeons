// Drives the UI in headless Chromium and writes screenshots to artifacts/.
// Playwright is not a dependency; point NODE_PATH at an install of it:
//
//   mkdir -p /tmp/dd-pw && (cd /tmp/dd-pw && bun add --exact playwright-core@1.63.0)
//   bunx playwright@1.63.0 install chromium   # once per machine
//   DECISION_DUNGEONS_HOME=/tmp/dd-home bun src/server/main.ts &
//   NODE_PATH=/tmp/dd-pw/node_modules bun scripts/browser-check.ts [nuclis-model]
//
// It plays Crossing with the rule, then with nuclis (a real local decision
// per case) unless the model argument is "none", and checks that a missing
// nuclis binary shows nuclis disabled with the reason. Use a throwaway
// DECISION_DUNGEONS_HOME: the check writes the config.

import { mkdirSync } from "node:fs";
// @ts-expect-error resolved through NODE_PATH, see above.
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:4317";
const OUT = "artifacts/screenshots";
const nuclisModel = process.argv[2] ?? "laya-multilingual";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const problems: string[] = [];
/** Set while a failure is injected: the browser logs the failed request itself. */
let injecting = false;
page.on("console", (m: { type(): string; text(): string }) => {
  if (m.type() === "error" && !injecting) problems.push(`console: ${m.text()}`);
});
page.on("pageerror", (e: Error) => problems.push(`page: ${e.message}`));

const shot = async (name: string) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`${OUT}/${name}.png`);
};
const pick = (value: string) =>
  page.locator(`label.pill:has(input[value="${value}"])`).first().click();

async function play(level: string, autopilot: string, name: string) {
  await page.goto(BASE);
  await page.locator(".picker").waitFor();
  await page.locator(`label.choice:has(input[value="${level}"])`).click();
  await pick(autopilot);
  await page.getByRole("button", { name: "Play" }).click();
  await page.locator(".hud").waitFor();
  await page.keyboard.press("n");
  await page.locator(".debug-sidebar:not([hidden]) .debug-options").waitFor();
  await shot(`${name}-running`);
  await page
    .locator(".outcome .pass, .outcome .fail")
    .waitFor({ timeout: 60_000 });
  await shot(`${name}-finished`);
  const verdict = await page.locator(".outcome").innerText();
  console.log(`${name}: ${verdict.replaceAll("\n", " ")}`);
  return verdict;
}

// Start screen.
await page.goto(BASE);
await page.locator(".picker").waitFor();
await shot("start");

// The rule passes every case.
const rule = await play("distance", "rule/baseline", "crossing-rule");
if (!rule.includes("Passed")) problems.push("the rule did not pass Crossing");

// A real nuclis model, one subprocess per decision.
if (nuclisModel !== "none")
  await play("distance", `nuclis/${nuclisModel}`, `crossing-${nuclisModel}`);

// A failed decision stops the run with the typed error; Retry asks again.
injecting = true;
await page.route("**/api/decide", (route: { fulfill(r: object): void }) =>
  route.fulfill({
    status: 502,
    contentType: "application/json",
    body: JSON.stringify({
      error: { code: "rejected", message: "nuclis decide failed: injected" },
    }),
  }),
);
await page.goto(BASE);
await page.locator(".picker").waitFor();
await pick("random/uniform");
await page.getByRole("button", { name: "Play" }).click();
await page.locator(".banner.error").waitFor();
await page.keyboard.press("n");
await shot("decision-failed");
await page.unroute("**/api/decide");
injecting = false;
await page.getByRole("button", { name: "Retry" }).click();
await page
  .locator(".outcome .pass, .outcome .fail")
  .waitFor({ timeout: 60_000 });
await shot("decision-retried");

// Config page.
await page.goto(`${BASE}/config`);
await page.locator(".config section").first().waitFor();
await shot("config");

// A missing binary disables nuclis and says why.
const bin = page.locator('input[name="nuclis-bin"]');
if (await bin.isEnabled()) {
  await bin.fill("/nonexistent/nuclis");
  await page
    .locator("section", { hasText: "Binary" })
    .getByRole("button", { name: "Save" })
    .click();
  await page.getByText("Saved.").waitFor();
  await page.goto(BASE);
  await page.locator(".picker-row.blocked").first().waitFor();
  await shot("start-nuclis-missing");
  const reason = await page
    .locator(".picker-row.blocked small")
    .first()
    .innerText();
  if (!reason.includes("not found"))
    problems.push(`unexpected reason: ${reason}`);
  // Put the binary back.
  await page.goto(`${BASE}/config`);
  await page.locator('input[name="nuclis-bin"]').fill("nuclis");
  await page
    .locator("section", { hasText: "Binary" })
    .getByRole("button", { name: "Save" })
    .click();
  await page.getByText("Saved.").waitFor();
}

await browser.close();
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("browser check passed");
