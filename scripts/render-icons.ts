// Renders the app icons from public/icons/favicon.svg: PNGs at 16, 32,
// 48, 180 (apple-touch-icon), 192, and 512, and favicon.ico holding the
// 16, 32, and 48 PNGs:
//
//   bun scripts/render-icons.ts

import { chromium } from "playwright-core";

const DIR = "public/icons";
const svg = await Bun.file(`${DIR}/favicon.svg`).text();

const browser = await chromium.launch();
const pngs = new Map<number, Uint8Array>();
for (const size of [16, 32, 48, 180, 192, 512]) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace(
      "<svg ",
      `<svg width="${size}" height="${size}" `,
    )}</body></html>`,
  );
  const png: Uint8Array = await page.screenshot({ omitBackground: true });
  pngs.set(size, png);
  await page.close();
}
await browser.close();

await Bun.write(`${DIR}/apple-touch-icon.png`, pngs.get(180) as Uint8Array);
await Bun.write(`${DIR}/icon-192.png`, pngs.get(192) as Uint8Array);
await Bun.write(`${DIR}/icon-512.png`, pngs.get(512) as Uint8Array);

/** An ICO whose entries are PNGs, as every current browser and Windows accept. */
function ico(images: [number, Uint8Array][]): Uint8Array {
  const header = 6 + 16 * images.length;
  const total = header + images.reduce((sum, [, png]) => sum + png.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, images.length, true);
  let offset = header;
  images.forEach(([size, png], i) => {
    const entry = 6 + 16 * i;
    view.setUint8(entry, size >= 256 ? 0 : size);
    view.setUint8(entry + 1, size >= 256 ? 0 : size);
    view.setUint8(entry + 2, 0); // no palette
    view.setUint8(entry + 3, 0);
    view.setUint16(entry + 4, 1, true); // color planes
    view.setUint16(entry + 6, 32, true); // bits per pixel
    view.setUint32(entry + 8, png.length, true);
    view.setUint32(entry + 12, offset, true);
    out.set(png, offset);
    offset += png.length;
  });
  return out;
}

await Bun.write(
  `${DIR}/favicon.ico`,
  ico([16, 32, 48].map((size) => [size, pngs.get(size) as Uint8Array])),
);
console.log(
  `wrote ${DIR}: apple-touch-icon.png, icon-192.png, icon-512.png, favicon.ico`,
);
