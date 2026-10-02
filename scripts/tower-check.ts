// Plays Night Tower in headless Chromium on the GPU with the rule and
// writes screenshots to artifacts/tower/: each camera, a question on
// screen, the strips and radio mid-shift, and the end card; it reports
// frame times and the shift's result.
//
//   DECISION_DUNGEONS_HOME=/tmp/dd-home-tw DECISION_DUNGEONS_PORT=7300 bun src/server/main.ts &
//   BASE_URL=http://127.0.0.1:7300 bun scripts/tower-check.ts [levels]

import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:7000";
const OUT = "artifacts/tower";
const levels = (process.argv[2] ?? "evening,go-around").split(",");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems: string[] = [];
page.on("console", (m: { type(): string; text(): string }) => {
  if (m.type() === "error" && !/GPU stall|software|SwiftShader/i.test(m.text()))
    problems.push(`console: ${m.text()}`);
});
page.on("pageerror", (e: Error) => problems.push(`page: ${e.message}`));
const shot = async (name: string) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};

async function frames(seconds: number) {
  const d: number[] = await page.evaluate(
    (s: number) =>
      new Promise<number[]>((resolve) => {
        const out: number[] = [];
        let last = performance.now();
        const end = last + s * 1000;
        const f = (t: number) => {
          out.push(t - last);
          last = t;
          if (t < end) requestAnimationFrame(f);
          else resolve(out.slice(1));
        };
        requestAnimationFrame(f);
      }),
    seconds,
  );
  const sorted = [...d].sort((a, b) => a - b);
  return {
    frames: d.length,
    p50_ms: Math.round((sorted[Math.floor(sorted.length / 2)] ?? 0) * 10) / 10,
    p95_ms:
      Math.round((sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 10) / 10,
    over_50ms: d.filter((x) => x > 50).length,
  };
}

for (const level of levels) {
  await page.goto(`${BASE}/d/tower`);
  await page
    .locator(`label:has(input[name="level"][value="${level}"])`)
    .click();
  await page.locator('label:has(input[value="rule/baseline"])').first().click();
  await page.getByRole("button", { name: "Start run" }).click();
  await page.locator(".tw-stage").waitFor();
  await page.waitForTimeout(2500);
  await shot(`${level}-tower`);
  if (level === "evening") {
    console.log(`frames: ${JSON.stringify(await frames(10))}`);
    // The rule answers in milliseconds; hold one answer back to see the question.
    await page.route(
      "**/api/decide",
      async (route: { continue(): Promise<void> }) => {
        await new Promise((r) => setTimeout(r, 2500));
        await route.continue();
      },
    );
    await page.locator(".tw-banner.ask").waitFor({ timeout: 180_000 });
    await page.waitForTimeout(600);
    await shot(`${level}-question`);
    await page.unroute("**/api/decide");
    await page
      .locator(".tw-banner.ok, .tw-banner.warn")
      .waitFor({ timeout: 30_000 });
    await shot(`${level}-answered`);
    await page.keyboard.press("c");
    await page.waitForTimeout(1500);
    await shot(`${level}-final`);
    await page.keyboard.press("c");
    await page.waitForTimeout(2500);
    await shot(`${level}-overview`);
    await page.keyboard.press("c");
    await page.keyboard.press("3");
  }
  await page.locator(".tw-end:not([hidden])").waitFor({ timeout: 600_000 });
  await page.waitForTimeout(500);
  await shot(`${level}-end`);
  const card = await page.locator(".tw-end-card").innerText();
  console.log(`${level}: ${card.replaceAll("\n", " · ")}`);
  if (!/PASSED/.test(card)) problems.push(`${level}: the rule did not pass`);
}

await browser.close();
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("tower check passed");
