// The `spawn` transport: each call runs the `nuclis` binary as a
// subprocess. Server only (Bun.spawn). nuclis is a black box: this module
// depends on nothing but the commands' printed output.

import { abortError } from "../contract/decider.ts";
import { DecideError } from "../contract/errors.ts";
import type { NuclisTransport } from "./nuclis.ts";

/** A decision's JSON is a few kilobytes; anything near this is not one. */
const OUTPUT_LIMIT = 4_000_000;
const STDERR_TAIL = 2_000;

export interface SpawnSettings {
  /** An absolute path or a command name found on the PATH. */
  bin: string;
  backend?: "cpu" | "metal";
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onOverflow: () => void,
): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) {
      onOverflow();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function run(
  bin: string,
  args: string[],
  input: string | null,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw abortError(signal);
  let proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([bin, ...args], {
      stdin: input === null ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });
  } catch {
    throw new DecideError("unconfigured", `nuclis was not found at ${bin}`);
  }
  if (input !== null && proc.stdin && typeof proc.stdin !== "number") {
    proc.stdin.write(input);
    await proc.stdin.end();
  }
  // Abort stops the wait as well as the process: a child the process left
  // behind could hold its pipes open long after it was killed.
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let stdout: string | null;
  let stderr: string;
  try {
    [stdout, stderr] = await Promise.race([
      Promise.all([
        readLimited(proc.stdout, OUTPUT_LIMIT, () => proc.kill()),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      aborted,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) proc.kill();
  }
  if (proc.exitCode !== 0) {
    const last = stderr.slice(-STDERR_TAIL).trim().split("\n").pop();
    throw new DecideError(
      "rejected",
      `nuclis ${args[0]} failed: ${last || `exit ${proc.exitCode ?? proc.signalCode}`}`,
    );
  }
  if (stdout === null)
    throw new DecideError("invalid_answer", "nuclis printed too much output");
  return stdout;
}

function parse(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new DecideError("invalid_answer", `${what} printed malformed JSON`);
  }
}

export function spawnTransport(settings: SpawnSettings): NuclisTransport {
  const { bin, backend } = settings;
  return {
    kind: "spawn",
    async version(signal) {
      const out = await run(bin, ["--version"], null, signal);
      return out.trim();
    },
    async models(signal) {
      const out = await run(bin, ["model", "ls", "--json"], null, signal);
      return parse(out, "nuclis model ls");
    },
    async decide(request, model, signal) {
      const args = [
        "decide",
        "--request",
        "-",
        "--json",
        "--explain",
        "--model",
        model,
      ];
      if (backend) args.push("--backend", backend);
      const out = await run(bin, args, JSON.stringify(request), signal);
      return parse(out, "nuclis decide");
    },
  };
}
