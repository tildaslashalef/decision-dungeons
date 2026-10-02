// A case renderer for tests: every pictured case gets the same 1×1 PNG, so
// no test needs a browser. The real one is src/server/render.ts.

import type { TextCase } from "../src/dungeons/text/cases.ts";

export const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export async function fakeRender(cases: TextCase[]): Promise<TextCase[]> {
  return cases.map((c) => (c.source ? { ...c, images: [TINY_PNG] } : c));
}
