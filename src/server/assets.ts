// Static 3D assets (models, textures, the Draco decoder) from public/,
// served read-only. Only these directories are reachable, and a path that
// leaves them is refused before the filesystem is touched.

import { join, normalize, sep } from "node:path";
import { log } from "./log.ts";

const PUBLIC = join(import.meta.dir, "../../public");
export const ASSET_DIRECTORIES = ["models", "textures", "draco"] as const;

export async function serveAsset(pathname: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("Bad path", { status: 400 });
  }
  const relative = normalize(decoded).replace(/^[/\\]+/, "");
  const top = relative.split(sep)[0];
  if (
    decoded.includes("\0") ||
    relative.split(sep).includes("..") ||
    !ASSET_DIRECTORIES.includes(top as (typeof ASSET_DIRECTORIES)[number])
  )
    return new Response("Not found", { status: 404 });
  const file = Bun.file(join(PUBLIC, relative));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, {
    headers: { "Cache-Control": "public, max-age=86400" },
  });
}

/** Browser workers, bundled by the server: Bun's HTML bundling does not follow `new Worker(new URL(...))`. */
const WORKERS: Record<string, string> = {
  "driving-sim.js": join(
    import.meta.dir,
    "../dungeons/driving/ui/sim.worker.ts",
  ),
};
const built = new Map<string, Promise<string>>();

async function bundle(entry: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: false,
  });
  const output = result.outputs[0];
  if (!result.success || !output)
    throw new Error(
      result.logs.map(String).join("\n") || "worker build failed",
    );
  return output.text();
}

/** Serves a bundled worker; `fresh` rebuilds it (development), otherwise it is built once. */
export async function serveWorker(
  name: string,
  fresh: boolean,
): Promise<Response> {
  const entry = Object.hasOwn(WORKERS, name) ? WORKERS[name] : undefined;
  if (!entry) return new Response("Not found", { status: 404 });
  let code = built.get(name);
  if (!code || fresh) {
    code = bundle(entry);
    built.set(name, code);
  }
  try {
    return new Response(await code, {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    built.delete(name);
    log.error(`worker ${name} failed to build`, { error });
    return new Response("Worker build failed", { status: 500 });
  }
}
