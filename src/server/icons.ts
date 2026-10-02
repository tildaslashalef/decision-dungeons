// The app icons and web manifest from public/icons/, at fixed routes.
// Each route names one file, so no request path reaches the filesystem.

import { join } from "node:path";

const DIR = join(import.meta.dir, "../../public/icons");

const FILES: Record<string, string> = {
  "favicon.svg": "image/svg+xml",
  "favicon.ico": "image/x-icon",
  "mark.svg": "image/svg+xml",
  "apple-touch-icon.png": "image/png",
  "icon-192.png": "image/png",
  "icon-512.png": "image/png",
  "site.webmanifest": "application/manifest+json",
};

const serve = (name: string, type: string) => () =>
  new Response(Bun.file(join(DIR, name)), {
    headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400" },
  });

/** `/icons/<file>` for each icon, and `/favicon.ico` where browsers look for it. */
export const iconRoutes: Record<string, () => Response> = {
  ...Object.fromEntries(
    Object.entries(FILES).map(([name, type]) => [
      `/icons/${name}`,
      serve(name, type),
    ]),
  ),
  "/favicon.ico": serve("favicon.ico", "image/x-icon"),
};
