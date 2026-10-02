// Drives the UI in headless Chromium and writes screenshots to artifacts/.
// Playwright is not a dependency; point NODE_PATH at an install of it:
//
//   mkdir -p /tmp/dd-pw && (cd /tmp/dd-pw && bun add --exact playwright-core@1.63.0)
//   bunx playwright@1.63.0 install chromium   # once per machine
//   DECISION_DUNGEONS_HOME=/tmp/dd-home bun src/server/main.ts &
//   NODE_PATH=/tmp/dd-pw/node_modules bun scripts/browser-check.ts [nuclis-model]
//
// It walks the gate into Crossing's lobby, plays Crossing with the rule,
// then with nuclis (a real local decision per case) unless the model
// argument is "none", and checks that an unreachable nuclis API shows nuclis
// disabled with the reason. It also shoots the gate at phone size. Use a
// throwaway DECISION_DUNGEONS_HOME: the check writes the config.

import { mkdirSync } from "node:fs";
// @ts-expect-error resolved through NODE_PATH, see above.
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:7000";
const OUT = "artifacts/screenshots";
const nuclisModel = process.argv[2] ?? "laya-multilingual";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems: string[] = [];
/** Set while a failure is injected: the browser logs the failed request itself. */
let injecting = false;
page.on("console", (m: { type(): string; text(): string }) => {
  if (m.type() === "error" && !injecting) problems.push(`console: ${m.text()}`);
});
page.on("pageerror", (e: Error) => problems.push(`page: ${e.message}`));

const shot = async (name: string, fullPage = true) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  console.log(`${OUT}/${name}.png`);
};
const pick = (value: string) =>
  page.locator(`label.pill:has(input[value="${value}"])`).first().click();
/** Opens a dungeon's lobby from the gate, as a player would. */
async function lobby(title = "Crossing", id = "crossing") {
  await page.goto(BASE);
  await page.locator(".portal", { hasText: title }).click();
  await page.waitForURL(`**/d/${id}`);
  await page.locator(".picker").waitFor();
}

async function play(
  level: string,
  autopilot: string,
  name: string,
  dungeon: [string, string] = ["Crossing", "crossing"],
) {
  await lobby(...dungeon);
  if (dungeon[1] !== "crossing")
    await page.locator('select[name="case-set"]').waitFor();
  await page.locator(`label.choice:has(input[value="${level}"])`).click();
  await pick(autopilot);
  await page.getByRole("button", { name: "Start run" }).click();
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

// The gate, the lobbies, and settings fit one screen at every desktop size:
// no page scroll.
for (const [width, height] of [
  [1280, 720],
  [1440, 900],
  [1920, 1080],
  [2000, 1020],
  [1024, 640],
]) {
  await page.setViewportSize({ width, height });
  for (const [path, ready, name] of [
    ["/", ".lights", "gate"],
    ["/d/crossing", ".picker", "lobby"],
    ["/d/driving", ".picker", "lobby-driving"],
    ["/d/inbox", ".picker", "lobby-inbox"],
    ["/d/tower", ".picker", "lobby-tower"],
    ["/config", ".card-nuclis", "config"],
  ] as const) {
    await page.goto(`${BASE}${path}`);
    await page.locator(ready).waitFor();
    await page.waitForTimeout(900);
    const fit = await page.evaluate(() => ({
      scroll: document.documentElement.scrollHeight,
      inner: window.innerHeight,
    }));
    if (fit.scroll > fit.inner)
      problems.push(`${name} scrolls at ${width}x${height}: ${fit.scroll}px`);
    await shot(`${name}-${width}x${height}`, false);
  }
}
await page.setViewportSize({ width: 1440, height: 900 });

// Driving's evaluation switch: off on entry, on when clicked, named in the summary.
await page.goto(`${BASE}/d/driving`);
await page.locator(".picker").waitFor();
const evaluation = page.locator('input[name="evaluation"]');
if (await evaluation.isChecked())
  problems.push("evaluation mode is on when entering the lobby");
await page.locator(".switch-row").click();
await page.locator(".switch-row").scrollIntoViewIfNeeded();
if (!(await page.locator(".start-summary").innerText()).includes("evaluation"))
  problems.push("the start summary does not name evaluation mode");
await shot("lobby-driving-evaluation");
await page.locator(".switch-row").click();

// Arrow keys move between gates; Enter goes in.
await page.goto(BASE);
await page.locator(".lights").waitFor();
const first = await page.locator(".portal.selected .plate-name").innerText();
await page.keyboard.press("ArrowRight");
const second = await page.locator(".portal.selected .plate-name").innerText();
if (first === second && (await page.locator(".portal").count()) > 1)
  problems.push("ArrowRight did not move to the next gate");
await page.keyboard.press("Home");
await page.locator(".portal", { hasText: "Crossing" }).focus();
await page.keyboard.press("Enter");
await page.waitForURL("**/d/crossing");

// The rule passes every case.
const rule = await play("distance", "rule/baseline", "crossing-rule");
if (!rule.includes("Passed")) problems.push("the rule did not pass Crossing");
// Leaving a run returns to its dungeon's lobby.
await page.getByRole("button", { name: "Exit" }).click();
await page.waitForURL("**/d/crossing");

// The text dungeons play from their base case sets.
for (const [title, id, level] of [
  ["Inbox", "inbox", "phishing"],
  ["Ticket triage", "tickets", "urgency"],
  ["Logs", "logs", "thresholds"],
] as const) {
  const verdict = await play(level, "rule/baseline", `${id}-rule`, [title, id]);
  if (!/Passed|Failed/.test(verdict)) problems.push(`${id} did not finish`);
  await page.getByRole("button", { name: "Exit" }).click();
  await page.waitForURL(`**/d/${id}`);
}

// A real nuclis model, one decision per case.
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
await lobby();
await pick("random/uniform");
await page.getByRole("button", { name: "Start run" }).click();
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
await page.locator(".settings-card").first().waitFor();
await shot("config");

// An unreachable nuclis API disables nuclis and says why.
const url = page.locator('input[name="nuclis-url"]');
if (await url.isEnabled()) {
  const saved = await url.inputValue();
  const save = () =>
    page.locator(".card-nuclis").getByRole("button", { name: "Save" }).click();
  await url.fill("http://127.0.0.1:9/v1");
  await save();
  await page
    .locator(".card-nuclis .save-status", { hasText: "Saved" })
    .waitFor();
  await lobby();
  await page.locator(".picker-row.blocked").first().waitFor();
  await shot("lobby-nuclis-down");
  const reason = await page
    .locator(".picker-row.blocked small")
    .first()
    .innerText();
  if (!reason.includes("not running"))
    problems.push(`unexpected reason: ${reason}`);
  // Put the URL back.
  await page.goto(`${BASE}/config`);
  await page.locator('input[name="nuclis-url"]').fill(saved);
  await save();
  await page
    .locator(".card-nuclis .save-status", { hasText: "Saved" })
    .waitFor();
}

// The gate and a lobby on a phone.
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(BASE);
await page.locator(".lights").waitFor();
await page.waitForTimeout(900);
await shot("gate-phone");
await lobby();
await shot("lobby-phone");

await browser.close();
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("browser check passed");
