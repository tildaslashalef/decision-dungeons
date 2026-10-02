// Drives the 3D driving stage in headless Chromium on the GPU (Metal on a
// Mac, through Playwright's full Chromium) and writes screenshots to
// artifacts/driving/. On the town drive it also reports frame times over
// 20 s in turn-based and in real-time play:
//
//   DECISION_DUNGEONS_HOME=/tmp/dd-home-3d DECISION_DUNGEONS_PORT=7200 bun src/server/main.ts &
//   BASE_URL=http://127.0.0.1:7200 bun scripts/driving-check.ts [levels]
//
// Each level is played by the rule autopilot. Install the full browser once
// with `bunx playwright@1.63.0 install chromium`.

import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:7000";
const OUT = "artifacts/driving";
const levels = (
  process.argv[2] ??
  "town,city,highway,stop-line,stop-sign,merge,blocked-lane,off-road"
).split(",");
mkdirSync(OUT, { recursive: true });

// Full Chromium's new headless mode renders on the GPU; the headless shell would use SwiftShader.
const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems: string[] = [];
page.on("console", (m: { type(): string; text(): string }) => {
  // SwiftShader warns about slow software paths; those are the test rig, not the app.
  if (m.type() === "error" && !/GPU stall|software|SwiftShader/i.test(m.text()))
    problems.push(`console: ${m.text()}`);
});
page.on("pageerror", (e: Error) => problems.push(`page: ${e.message}`));

const shot = async (name: string) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
};
const text = (selector: string) => page.locator(selector).first().innerText();

/** Frame times over `seconds`, from requestAnimationFrame. */
async function frames(seconds: number) {
  const deltas: number[] = await page.evaluate(
    (s: number) =>
      new Promise<number[]>((resolve) => {
        const d: number[] = [];
        let last = performance.now();
        const end = last + s * 1000;
        const f = (t: number) => {
          d.push(t - last);
          last = t;
          if (t < end) requestAnimationFrame(f);
          else resolve(d.slice(1));
        };
        requestAnimationFrame(f);
      }),
    seconds,
  );
  const sorted = [...deltas].sort((a, b) => a - b);
  const q = (p: number) =>
    Math.round((sorted[Math.floor(p * (sorted.length - 1))] ?? 0) * 10) / 10;
  return {
    frames: deltas.length,
    p50_ms: q(0.5),
    p95_ms: q(0.95),
    max_ms: Math.round((sorted.at(-1) ?? 0) * 10) / 10,
    over_50ms: deltas.filter((d) => d > 50).length,
  };
}

async function start(level: string, seed = 1) {
  await page.goto(`${BASE}/d/driving`);
  await page
    .locator(`label:has(input[name="level"][value="${level}"])`)
    .first()
    .click();
  await page.locator('label:has(input[value="rule/baseline"])').first().click();
  const seedInput = page.locator('input[type="number"]').first();
  if (await seedInput.count()) await seedInput.fill(String(seed));
  await seedInput.press("Tab").catch(() => {});
  await page
    .getByRole("button", { name: /start run|play/i })
    .first()
    .click();
  await page.locator(".dd-stage").waitFor();
  await page
    .locator(".dd-loader")
    .waitFor({ state: "hidden", timeout: 120_000 });
}

/** Waits until `predicate` holds in the page, polling every 200 ms. */
async function until(predicate: string, timeout = 120_000) {
  await page.waitForFunction(predicate, null, { timeout, polling: 200 });
}

for (const level of levels) {
  const started = performance.now();
  await start(level, level === "stop-line" ? 42 : 1);
  if (level === "town") {
    await page.waitForTimeout(1500);
    console.log(`frames turn-based: ${JSON.stringify(await frames(20))}`);
    await shot("town-chase");
    await page.locator(".dd-candidates").click();
    await page.waitForTimeout(2500);
    await shot("town-candidates");
    await page.keyboard.press("c");
    await page.waitForTimeout(1500);
    await shot("town-driver");
    await page.keyboard.press("c");
    await page.waitForTimeout(1500);
    await shot("town-birdseye");
    await page.keyboard.press("c");
    await page.keyboard.press("n");
    await page.waitForTimeout(1500);
    await shot("town-debug");
    await page.keyboard.press("n");
    await page.getByRole("button", { name: "Inspect live JSON" }).click();
    await page.waitForTimeout(800);
    await shot("town-inspector");
    await page.getByRole("button", { name: "Full world" }).click();
    await page.waitForTimeout(1500);
    await shot("town-inspector-world");
    const world = await text(".json-content");
    if (!world.includes('"traffic_controls"') || !world.includes('"vehicles"'))
      problems.push("the Full world tab shows no world");
    console.log(
      `frames with the world open: ${JSON.stringify(await frames(5))}`,
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("t");
    await page.waitForTimeout(1500);
    console.log(`frames real-time: ${JSON.stringify(await frames(20))}`);
    await shot("town-realtime");
    await page.keyboard.press("t");
    await until(
      '!!document.querySelector(".dd-arrival:not([hidden]), .dd-crash[open]")',
      600_000,
    );
    await page.waitForTimeout(1500);
    await shot("town-finished");
  }
  if (level === "city") {
    await page.waitForTimeout(15_000);
    await shot("city-chase");
  }
  if (level === "highway") {
    await until(
      '/acceleration lane|Merge/i.test(document.querySelector(".dd-navigation-card")?.textContent ?? "")',
      600_000,
    );
    await page.waitForTimeout(2500);
    await shot("highway-onramp");
    await until(
      '/Cedar Town exit/i.test(document.querySelector(".dd-navigation-card")?.textContent ?? "")',
      600_000,
    );
    await page.waitForTimeout(4000);
    await shot("highway-interstate");
  }
  if (level === "stop-line") {
    await page.waitForTimeout(3000);
    await until(
      'document.querySelector(".dd-speed strong")?.textContent === "0"',
      120_000,
    );
    await page.waitForTimeout(400);
    await shot("stop-line-red");
    await until(
      '!!document.querySelector(".dd-arrival:not([hidden])")',
      120_000,
    );
    await page.waitForTimeout(800);
    await shot("stop-line-finished");
    console.log(
      `stop-line: ${(await text(".dd-arrival")).replaceAll("\n", " · ")}`,
    );
  }
  if (["stop-sign", "merge", "blocked-lane", "off-road"].includes(level)) {
    await page.waitForTimeout(level === "merge" ? 9000 : 4000);
    await shot(`${level}-running`);
    await until(
      '!!document.querySelector(".dd-arrival:not([hidden]), .dd-crash[open]")',
      300_000,
    );
    await page.waitForTimeout(800);
    await shot(`${level}-finished`);
    const card = await text(".dd-arrival:not([hidden]), .dd-crash[open]");
    console.log(`${level}: ${card.replaceAll("\n", " · ")}`);
    if (!/PASSED/.test(card)) problems.push(`${level}: the rule did not pass`);
  }
  console.log(
    `${level}: ${Math.round((performance.now() - started) / 1000)} s`,
  );
}

await browser.close();
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("driving check passed");
