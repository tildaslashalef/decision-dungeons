// A fake `nuclis` executable: a shell script that records its arguments
// and standard input, then prints canned output. No model, GPU, or network.

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeNuclis {
  dir: string;
  bin: string;
  /** The arguments of the last call, space-separated. */
  args(): string;
  /** What the last call read from standard input. */
  stdin(): string;
  remove(): void;
}

export interface FakeScripts {
  version?: string;
  models?: string;
  decide?: string;
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** Each script is shell run for its command; `print(value)` builds one that echoes JSON. */
export function fakeNuclis(scripts: FakeScripts): FakeNuclis {
  const dir = mkdtempSync(join(tmpdir(), "fake-nuclis-"));
  const bin = join(dir, "nuclis");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" > "${dir}/args"
case "$1" in
  --version) ${scripts.version ?? "echo 'nuclis 0.4.0-test'"} ;;
  model) ${scripts.models ?? "exit 3"} ;;
  decide) cat > "${dir}/stdin"; ${scripts.decide ?? "exit 3"} ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return {
    dir,
    bin,
    args: () => readFileSync(join(dir, "args"), "utf8").trim(),
    stdin: () => readFileSync(join(dir, "stdin"), "utf8"),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function print(value: unknown): string {
  return `printf '%s\\n' ${quote(JSON.stringify(value))}`;
}

/** What `nuclis decide --json --explain` prints for one choice question named motion. */
export function decideOutput(choice = "stop") {
  return {
    schema_version: 1,
    model: "laya",
    repo: "convaiinnovations/laya",
    revision: "55cf4c4e",
    timings_ms: { load: 70.4, tokenize: 0.1, encode: 76.7 },
    results: [
      {
        answers: {
          motion: {
            type: "choice",
            choice,
            probabilities:
              choice === "stop"
                ? { drive: 0.4016, stop: 0.5984 }
                : { drive: 0.5984, stop: 0.4016 },
            confidence: 0.0281,
            nuclis: {
              answer_confidence: 0.5984,
              logits: [-0.38, 0.37],
              temperature: 1.9,
              bucket: "choice:2",
              sequence_tokens: 44,
              state_kept: 18,
            },
          },
        },
        usage: { input_tokens: 44, output_tokens: 0 },
        nuclis: { state: "state[0]", state_tokens: 18, truncated: false },
      },
    ],
  };
}

export const modelListing = {
  schema_version: 4,
  catalog: [
    { name: "qwen3.8-27b", kind: "generation", status: "present" },
    { name: "laya", kind: "decision", status: "present" },
    { name: "laya-multilingual", kind: "decision", status: "present" },
    { name: "clef-flash", kind: "decision", status: "absent" },
  ],
};
