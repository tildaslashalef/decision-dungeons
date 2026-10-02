// Renders pictured cases (`TextCase.source`) to PNG data URLs in headless
// Chromium, through playwright-core. Server and CLI only; the case store
// loads it when a set has pictures to render, so nothing else needs a
// browser.

import { chromium } from "playwright-core";
import type { TextCase } from "../dungeons/text/cases.ts";
import { CaseError } from "./cases.ts";

/** The element of a source page that becomes the picture. */
export const PAGE_SELECTOR = "#page";

export async function renderCases(cases: TextCase[]): Promise<TextCase[]> {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch();
  } catch (error) {
    throw new CaseError(
      `rendering pictures needs Chromium; install it once with \`bunx playwright@1.63.0 install chromium\` (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
    );
  }
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const out: TextCase[] = [];
    for (const c of cases) {
      if (!c.source) {
        out.push(c);
        continue;
      }
      await page.setViewportSize({ width: c.source.width, height: 600 });
      await page.setContent(c.source.html, { waitUntil: "load" });
      const png = await page
        .locator(PAGE_SELECTOR)
        .screenshot({ type: "png", animations: "disabled" });
      out.push({
        ...c,
        images: [
          `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
        ],
      });
    }
    return out;
  } finally {
    await browser.close();
  }
}
