// Frame-time comparison: our driving stage against the reference simulator
// (NOTICE.md), same machine,
// same headless Chromium on the GPU (Metal), same viewport, 20 s of town
// driving each. Development check only; see driving-check.ts for setup.
//
//   NODE_PATH=/tmp/dd-pw/node_modules bun scripts/frame-probe.ts [ours-url] [reference-url] [mode]
//
// mode: turn (default) or realtime, for our stage; autopilot: decider/model
// (default rule/baseline). The reference must run its
// dev server with a local decider (DECIDER=nuclis) so nothing paid is called.

// @ts-expect-error resolved through NODE_PATH.
import { chromium } from "playwright-core";

const ours = process.argv[2] ?? "http://127.0.0.1:7200";
const reference = process.argv[3] ?? "http://localhost:5199";
const mode = process.argv[4] ?? "turn";
/** The autopilot pill value, decider/model. */
const autopilot = process.argv[5] ?? "rule/baseline";
const SECONDS = 20;

interface Stats {
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  over50: number;
  over100: number;
}

function stats(deltas: number[]): Stats {
  const sorted = [...deltas].sort((a, b) => a - b);
  const q = (p: number) =>
    Math.round(
      (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ??
        0) * 10,
    ) / 10;
  const total = deltas.reduce((a, b) => a + b, 0);
  return {
    frames: deltas.length,
    fps: Math.round((deltas.length / total) * 1000 * 10) / 10,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: Math.round((sorted.at(-1) ?? 0) * 10) / 10,
    over50: deltas.filter((d) => d > 50).length,
    over100: deltas.filter((d) => d > 100).length,
  };
}

/**
 * How evenly the rendered car moves: per-frame travel d, and the change in
 * d from frame to frame relative to the mean travel, over frames where the
 * car is moving (d > 3 cm). Stepping without interpolation shows as large
 * jumps; smooth motion keeps the ratio small.
 */
function smoothness(poses: number[]) {
  const travel: number[] = [];
  for (let i = 2; i + 1 < poses.length; i += 2)
    travel.push(
      Math.hypot(
        (poses[i] ?? 0) - (poses[i - 2] ?? 0),
        (poses[i + 1] ?? 0) - (poses[i - 1] ?? 0),
      ),
    );
  const moving = travel.filter((d) => d > 0.03);
  const mean = moving.reduce((a, b) => a + b, 0) / Math.max(1, moving.length);
  const jumps: number[] = [];
  for (let i = 1; i < travel.length; i++)
    if ((travel[i] ?? 0) > 0.03 && (travel[i - 1] ?? 0) > 0.03)
      jumps.push(Math.abs((travel[i] ?? 0) - (travel[i - 1] ?? 0)) / mean);
  jumps.sort((a, b) => a - b);
  const q = (p: number) =>
    Math.round(
      (jumps[Math.min(jumps.length - 1, Math.floor(p * jumps.length))] ?? 0) *
        1000,
    ) / 1000;
  const stills = travel.filter((d) => d <= 0.001).length;
  return {
    moving_frames: moving.length,
    mean_travel_m: Math.round(mean * 1000) / 1000,
    jump_p50: q(0.5),
    jump_p95: q(0.95),
    jump_max: q(1),
    still_frames: stills,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: Playwright's page, untyped here.
async function collect(page: any): Promise<number[]> {
  return page.evaluate(
    (seconds: number) =>
      new Promise<number[]>((resolve) => {
        const deltas: number[] = [];
        let last = performance.now();
        const end = last + seconds * 1000;
        const frame = (t: number) => {
          deltas.push(t - last);
          last = t;
          if (t < end) requestAnimationFrame(frame);
          else resolve(deltas.slice(1));
        };
        requestAnimationFrame(frame);
      }),
    SECONDS,
  );
}

const browser = await chromium.launch({ channel: "chromium" });
const renderer = async (page: {
  evaluate: (f: () => string) => Promise<string>;
}) =>
  page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext && gl
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : "unknown";
  });

// Ours.
{
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.goto(`${ours}/d/driving`);
  await page
    .locator('label:has(input[name="level"][value="town"])')
    .first()
    .click();
  await page.locator(`label:has(input[value="${autopilot}"])`).first().click();
  await page
    .getByRole("button", { name: /start run|play/i })
    .first()
    .click();
  await page
    .locator(".dd-loader")
    .waitFor({ state: "hidden", timeout: 120_000 });
  if (mode === "realtime") await page.keyboard.press("t");
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    (
      window as unknown as { __ddFrames: { poses: number[] } }
    ).__ddFrames.poses.length = 0;
  });
  const deltas = await collect(page);
  const poses: number[] = await page.evaluate(
    () =>
      (window as unknown as { __ddFrames: { poses: number[] } }).__ddFrames
        .poses,
  );
  const speed = await page.locator(".dd-speed strong").innerText();
  console.log(
    JSON.stringify({
      app: "decision-dungeons",
      mode,
      autopilot,
      renderer: await renderer(page),
      speed_kmh_at_end: speed,
      ...stats(deltas),
      motion: smoothness(poses),
    }),
  );
  await page.close();
}

// The reference, autopilot engaged with its local decider.
{
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.goto(`${reference}/?world=town&seed=1`);
  await page
    .locator("#scene-loader")
    .waitFor({ state: "hidden", timeout: 120_000 });
  await page.keyboard.press("j");
  await page.waitForTimeout(1500);
  const deltas = await collect(page);
  const speed = await page.locator("#speed").innerText();
  console.log(
    JSON.stringify({
      app: "reference",
      mode: "realtime",
      renderer: await renderer(page),
      speed_kmh_at_end: speed,
      ...stats(deltas),
    }),
  );
  await page.close();
}

await browser.close();
