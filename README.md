# Decision Dungeons

A local playground for decision models. Each **dungeon** is a seeded world
that asks a decider typed questions (a yes/no probability, one option of
several, a score on a scale) about what it sees. You pick the dungeon, its
level, and the autopilot (decider and model), then watch it play with a
debug sidebar showing what the decider read and answered. The same runs
play headless from the command line and produce comparison tables.

## Dungeons

| Dungeon | What the decider does | Levels |
| --- | --- | --- |
| **Autopilot driving** (3D) | Chooses each maneuver of a car through traffic | Town, city, interstate; stop line, stop sign, merge gap, blocked lane, off-road recovery |
| **Night Tower** (3D) | Works an airport tower: clear each arrival to land or send it around, release departures between them | Quiet evening, rush hour, low visibility, go-around check |
| **Inbox** | Spots phishing and fraud, files mail | Phishing, filing, four languages, long digests |
| **Ticket triage** | Routes support tickets, scores urgency, spots refund requests | Routing, urgency, refunds, four languages |
| **Logs** | Decides whether to page on-call from production logs | Page or not, numbers against a policy, root cause, long windows |
| **Crossing** | Drives or stops at a signalled line | Signal, distance, both |

Every run is deterministic: the same seed and the same answers give the
same run, in the browser and headless. Every case has a known answer or a
stated pass bound, so each decision is scored.

## Deciders

- **nuclis**: local decision models (`laya`, `laya-multilingual`,
  `clef-flash`, and any decision model nuclis adds) through `nuclis
  serve`'s HTTP API. Laya answers in milliseconds; clef-flash, a 9B
  model, takes about a second or more per state.
- **TypeSafe Jev**: the hosted API, billed per input token; needs a key.
- **Fixed rule**: each dungeon's deterministic baseline.
- **Random**: seeded uniform choice; the floor.

Answers are validated: an option that was not offered, a probability that
is not finite, or a missing answer is a typed error, never repaired.

## Requirements

- [Bun](https://bun.sh) 1.4
- For nuclis: `nuclis serve` running locally (default
  `http://127.0.0.1:8000/v1`). The rule and random deciders need nothing.
- For TypeSafe Jev: an API key.

## Quick start

```sh
bun install
bun run dev        # http://127.0.0.1:7000
```

Open the gate, choose a dungeon, then a level, an autopilot, and a seed.
In play, **N** toggles the debug sidebar. In the 3D dungeons, **C**
switches cameras; driving's **T** toggles turn-based and real time, and
Night Tower's **1–3** set the time speed.

## Headless runs

```sh
# Driving trips on four seeds, with the safety nets off
bun run eval --dungeon driving --level town,city --decider nuclis --model laya-multilingual --seeds 1-4 --evaluation

# One scenario check
bun run check driving/stop-line --decider rule

# A text dungeon from a named case set
bun run eval --dungeon logs --level thresholds --decider rule --seeds 1-4 --set base
```

Each run prints a JSON line, then a markdown table of the same results;
`--json` prints the lines only. Text dungeons send their independent cases
to nuclis in batches unless you pass `--sequential`, when the model packs
states into one GPU pass (Laya); clef-flash is sent one case at a time.

## Case sets

The text dungeons play synthetic cases (emails, tickets, log windows)
written by seeded generators, so every label follows from how the case
was built. They live in SQLite at `~/.decision-dungeons/dungeons.db`. Sets
are immutable and content-hashed, and each result records the set it
played.

```sh
bun run seed                                              # each dungeon's base set (also written on first use)
bun run seed --dungeon inbox --set more --seed 7 --count 400
bun run seed --dungeon logs --set hard --seed 3 --level thresholds=500
bun run seed --list
```

## Configuration

Settings live in `~/.decision-dungeons/config.json` (mode 600) and can be
edited on the settings page. Environment variables override them:

| Variable | Default | Meaning |
| --- | --- | --- |
| `NUCLIS_URL` | `http://127.0.0.1:8000/v1` | the nuclis API |
| `TYPESAFE_API_KEY` | — | TypeSafe Jev's key; the browser can set it but never reads it back |
| `DECISION_DUNGEONS_HOME` | `~/.decision-dungeons` | config and case sets (absolute path) |
| `DECISION_DUNGEONS_PORT` | `7000` | server port (always bound to `127.0.0.1`) |
| `DECISION_DUNGEONS_LOG` | `info` | `debug`, `info`, `warn`, or `error` |

## Development

```sh
bun test           # no network, model, GPU, or key needed
bun run lint       # tsc --noEmit and biome check
```

Tests stub the nuclis API; `tests/nuclis-live.test.ts` also runs against a
real `nuclis serve` when one answers. Browser checks (`scripts/*-check.ts`)
drive the UI in headless Chromium through `playwright-core`, which is not
a dependency; see each script's header for setup.

The driving simulation is checked decision by decision against JevPilot,
which it rewrites, given a JevPilot checkout (branch `nuclis-decider`):

```sh
DRIVING_REFERENCE=/path/to/jevpilot bun scripts/driving-reference.ts all
```

```
src/
  contract/    request and answer types, validation, the decide path
  deciders/    nuclis, TypeSafe, random
  dungeons/    driving, tower, inbox, tickets, logs, crossing, and the shared text builder
  server/      Bun.serve API, config, case store, logging
  ui/          gate, lobbies, settings, play view, debug sidebar
  cli/         eval and seed
tests/
scripts/       browser checks, the JevPilot reference comparison, icon rendering
```

## Credits

The driving dungeon is a rewrite of Standard Agents' JevPilot, used with
permission. Asset licenses and attributions are in [NOTICE.md](NOTICE.md).
