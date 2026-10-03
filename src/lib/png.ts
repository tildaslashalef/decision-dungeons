// A minimal PNG writer: 8-bit palette images, one IDAT chunk, every row
// unfiltered, compressed by the platform's zlib (`CompressionStream`), which
// Bun and browsers both have. Seeded pictures are then the same bytes in
// `bun run eval` and in the browser, and nothing needs a renderer.

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as PNG chunks carry it (ISO 3309, the zlib polynomial). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A palette image: `pixels[y * width + x]` indexes `palette`. */
export interface PaletteImage {
  width: number;
  height: number;
  /** At most 256 colours, each [r, g, b]. */
  palette: [number, number, number][];
  pixels: Uint8Array;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePng(image: PaletteImage): Promise<Uint8Array> {
  const { width, height, palette, pixels } = image;
  if (palette.length < 1 || palette.length > 256)
    throw new Error("a PNG palette holds 1 to 256 colours");
  if (pixels.length !== width * height)
    throw new Error("pixels must be width × height");
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 3; // colour type: palette
  // header[10..12]: deflate, adaptive filtering, no interlace (all zero).
  const plte = new Uint8Array(palette.length * 3);
  palette.forEach(([r, g, b], i) => {
    plte.set([r, g, b], i * 3);
  });
  // Each row is its filter byte (0, none) and its indices.
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++)
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk("IHDR", header),
    chunk("PLTE", plte),
    chunk("IDAT", await zlib(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Bytes as a `data:image/png;base64,…` URL, without Buffer or btoa's string limits. */
export function pngDataUrl(png: Uint8Array): string {
  const ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < png.length; i += 3) {
    const a = png[i] as number;
    const b = png[i + 1];
    const c = png[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out +=
      (ALPHABET[(n >> 18) & 63] as string) +
      (ALPHABET[(n >> 12) & 63] as string) +
      (b === undefined ? "=" : (ALPHABET[(n >> 6) & 63] as string)) +
      (c === undefined ? "=" : (ALPHABET[n & 63] as string));
  }
  return `data:image/png;base64,${out}`;
}
