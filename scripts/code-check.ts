import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:7100";
const OUT = "artifacts/screenshots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems: string[] = [];

page.on("console", (m: { type(): string; text(): string }) => {
  if (m.type() === "error") problems.push(`console: ${m.text()}`);
});
page.on("pageerror", (e: Error) => problems.push(`page: ${e.message}`));

const shot = async (name: string, fullPage = true) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  console.log(`Saved screenshot: ${OUT}/${name}.png`);
};

// 1. Gate view showing portals including Code Review and Bugfix Workbench
await page.goto(BASE);
await page.locator(".lights").waitFor();
await page.waitForTimeout(500);
await shot("gate-with-code-dungeons");

// 2. Review lobby
await page.goto(`${BASE}/d/review`);
await page.locator(".picker").waitFor();
await page.waitForTimeout(500);
await shot("lobby-review");

// Play review with rule
await page.locator('label.choice:has(input[value="gate"])').click();
await page
  .locator('label.pill:has(input[value="rule/baseline"])')
  .first()
  .click();
await page.getByRole("button", { name: "Start run" }).click();
await page.locator(".hud").waitFor();
await page.waitForTimeout(1000);
await shot("review-play");

// 3. Bugfix lobby
await page.goto(`${BASE}/d/bugfix`);
await page.locator(".picker").waitFor();
await page.waitForTimeout(500);
await shot("lobby-bugfix");

// Play bugfix with rule
await page.locator('label.choice:has(input[value="single"])').click();
await page
  .locator('label.pill:has(input[value="rule/baseline"])')
  .first()
  .click();
await page.getByRole("button", { name: "Start run" }).click();
await page.locator(".hud").waitFor();
await page.locator(".workbench-container").waitFor();
await page.waitForTimeout(1000);
await shot("bugfix-workbench-running");

// Wait for finish
await page
  .locator(".outcome .pass, .outcome .fail")
  .waitFor({ timeout: 15_000 });
await page.waitForTimeout(500);
await shot("bugfix-workbench-finished");

await browser.close();

if (problems.length > 0) {
  console.error("Problems found:", problems);
  process.exit(1);
} else {
  console.log("All UI checks passed with zero console/page errors!");
}
