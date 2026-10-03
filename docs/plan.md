# Decision Dungeons — plan

A local playground for decision models. Each **dungeon** is a world that
asks a decider typed questions about what it sees; the player picks the
dungeon, its level, and the **autopilot** (which decider, which model), then
watches it play, with a debug sidebar showing what the decider read and
answered. The same dungeons run headless and produce comparison tables.

Status (2026-10-03): milestones 1 to 5, 7, and 8 are done, with a ninth
dungeon beside them: the skeleton, driving (headless and proven
bit-identical against the reference simulator, then its UI), the text
dungeons (Inbox, Ticket triage, Logs, cases in SQLite), Night Tower, The
Oracle (forecasts scored against true probabilities), Undercroft (a
dungeon crawler with text maps and tile pictures), and Evensong (the
autopilot harmonizes hymns at the organ). Milestone 6 (vision) has its
first dungeon, Receipts. A new session starts at *Start here* below.

## Start here

1. Read this plan, then `AGENTS.md`.
2. Read the references below, in that order, before writing code.
3. Read *Progress* at the end of this file, then *Working notes* below,
   and continue from **Pick up here**. Record what each session delivered
   in *Progress*.

**What exists and what does not, today.** The user runs `nuclis serve`
(nuclis 0.4.0-dev) at `http://127.0.0.1:8000/v1` with `laya`,
`laya-multilingual`, and `clef-flash`; the nuclis decider reaches it over
HTTP only (`AGENTS.md` § *Typed decisions come from the local nuclis API*). Never
start or configure it; if it refuses connections, tell the user. The rule
and random deciders need nothing. Tests stub the nuclis API
(`tests/fake-nuclis.ts`, an injected `fetch`) and never need a server, a
model, a GPU, a key, or the network; `tests/nuclis-live.test.ts` runs
against the real server only when `GET /v1/health` answers. The TypeSafe
decider is tested against a stubbed `fetch`; a real Jev call needs
`TYPESAFE_API_KEY` and is an explicit command, never a default test.
`clef-flash` takes images (`nuclis.images` in `GET /v1/models`); milestone
6 is under way with Receipts, the first dungeon with pictures.

## Working notes

What a new session needs before touching code; the rules themselves are
in `AGENTS.md`.

- **Run it.** `bun run dev` serves http://127.0.0.1:7000 (`/` the gate,
  `/d/<dungeon>` a lobby, `/play`, `/config`). For checks use a
  throwaway config home and another port, so the user's
  `~/.decision-dungeons` and dev server are untouched:
  `DECISION_DUNGEONS_HOME=/tmp/dd-home DECISION_DUNGEONS_PORT=7100 bun src/server/main.ts`.
  The user's shell sets `TYPESAFE_API_KEY`; never call TypeSafe in a
  check (it is billed). The server logs to stdout through
  `src/server/log.ts` (one line per API request; colored on a terminal,
  `NO_COLOR`/`FORCE_COLOR` honored; `DECISION_DUNGEONS_LOG=debug|info|warn|error`,
  default `info`). `bun run eval` keeps stdout for its JSON lines.
- **nuclis.** `curl -s 127.0.0.1:8000/v1/health` says whether the user's
  server is up and which models are open; the settings page shows the
  same as the nuclis card's badge. `NUCLIS_URL` overrides the configured
  URL. Each model's entry in `GET /v1/models` says how it runs
  (`nuclis.packs`). Laya packs: a warm decision takes 15–35 ms and
  states sent together share a GPU pass, so evals over many seeds are
  cheap. `clef-flash` does not: about 1 s for a short request, 4 ms per
  sequence token, one state after another, and every other request waits
  behind it (nuclis queues a request up to 300 s). Never leave a clef
  eval running in the background of a check; it holds the GPU.
- **Check it.** `bun test` (111 tests, 3 of them live against nuclis when
  it is up; no network or model otherwise), `bun run lint`
  (`tsc --noEmit` and `biome check`), `bun run eval …` and
  `bun run check driving/stop-line --decider rule` (*Headless runs*).
- **The driving simulation is proven bit-identical to the reference simulator.** After
  any change under `src/dungeons/driving/{world,sim,decide}` or
  `driving.ts`, run `DRIVING_REFERENCE=<checkout> bun scripts/driving-reference.ts all` (about 15 min;
  `town 1` and `stop-line 42` take 20 s) and keep every run
  `"identical": true`. Floating-point operation order matters: reorder
  no sum, and draw from the seeded generators in the same order. The
  reference checkout's location is in `README.md`.
- **Browser checks.** `playwright-core` is a dev dependency; its browser
  is installed once per machine (`bunx playwright@1.63.0 install
  chromium`). Then `BASE_URL=http://127.0.0.1:7100 bun scripts/browser-check.ts none`
  (gate, lobbies, settings, Crossing; asserts no page scroll at five
  desktop sizes) and `… bun scripts/driving-check.ts` (the 3D stage,
  screenshots to `artifacts/driving/`, frame times). Look at every
  screenshot before calling UI work done.
- **Bun gotchas.** Bun's HTML bundler resolves every `href`/`src` in
  `src/ui/index.html` at build time: link files by relative path (see the
  icon links), or the whole site returns 500. It does not follow
  `new Worker(new URL(...))`: the driving worker is built on request and
  served at `/workers/driving-sim.js` (`src/server/assets.ts`).
- **The user approved the gate and the settings page as they are.** Do
  not restructure them without asking; new pages follow their language
  (night sky, arch gateways, white cards, Fraunces and DM Sans). Icons
  only where they carry meaning, never in front of a heading or a plain
  label.

## How this started: the reference experiment

On 2026-10-02 nuclis's Laya decision model was tested as a drop-in for
TypeSafe's hosted Jev in the reference driving simulator (`NOTICE.md`), by
running `nuclis decide` as a subprocess. What it showed, which this
project builds on:

- **Jev's request shape is the interface.** `nuclis decide --request -
  --json` reads Jev's request (`state`, `questions`) and writes Jev's
  answers, so swapping deciders is one function.
- **Short-budget models need the request rewritten.** Laya reads 512
  tokens (`laya-multilingual` 1,024); the reference simulator's state was 700–850 tokens
  with the candidate table last, so Laya never saw the options. Moving each
  candidate's facts into its option text, situational instructions first
  and road geometry last, fixed it and cost Jev nothing (Jev stopped within
  0.13 m of its own result on the rewritten request).
- **Outcomes hide decisions.** The reference simulator's candidate filter, speed taper,
  and safety brake let a uniform-random decider arrive on 12 of 12 trips.
  Only a targeted check separated deciders: the red-light stop line
  (stop with the car's center within 3.5 m of the line, then go on green).
  `laya-multilingual` passed (bumper 0.52 m from the line), a fixed rule
  passed (0.70 m); `laya` (1.42 m), Jev 1.13.0 (1.55 m), and random failed.
- **Checkpoints differ by task.** `laya-multilingual` won the
  number-comparison decision at the stop line (P = 0.99 drive vs `laya`'s
  coin flip); `laya` won English filtering tasks in nuclis's own tests
  (ranking logs, cache misses, search hits). Neither is "the best"; the
  dungeons measure that.
- **Latency.** A subprocess decision cost about 0.5 s with `laya` and
  0.75 s with `laya-multilingual`, half of it process start and model
  load. nuclis has queued `nuclis serve` (APPS-19), its local HTTP API:
  decisions first (models kept loaded, concurrent requests batched),
  OpenAI-compatible chat for its language models later.
- **A third model is coming: Cloudflare's clef-flash** (nuclis MODL-34,
  after APPS-19): Qwen3.5-9B plus a joint schema head that answers every
  question of a request in one pass, reads states up to 16,384 tokens, and
  takes images and video. It runs as a quantized GGUF backbone (Q6_K) with
  the original head; expect roughly 1–3 s per decision on the M4 Pro (an
  estimate), so slow deciders need a turn-based mode. Its vision opens the
  image dungeons of milestone 6.

## References

- **The reference simulator** (`NOTICE.md` names it and its commits; the
  checkout's location is in `README.md`). The source of the driving
  dungeon's look and behaviour. Rewrite, never copy files wholesale
  (`AGENTS.md`). Read first:
  - `README.md` § *Decide locally with nuclis* and *What it shows*: the
    integration and the measurements above.
  - `server/nuclis.js` (the subprocess decider), `src/nuclis-request.js`
    (the rewrite), `src/nuclis-debug.js` (the debug sidebar),
    `server/jev.js` (the TypeSafe decider and `evaluate`).
  - `src/jev-request.js` (state to request), `src/planning.js`
    (candidates, `decisionSelection`), `src/simulation.js` and
    `src/driving-plan.js` (the simulation), `src/scene.js` and
    `src/main.js` (the UI).
  - `scripts/verify-jev.mjs`, `scripts/verify-stop-line.mjs`: the headless
    trip and the stop-line check, both taking `DECIDER=nuclis`.
- **nuclis**, `~/Code/nuclis`, used only as a black box over HTTP:
  - `docs/reference/api.md`: **the contract** of `nuclis serve`
    (`/v1/health`, `/v1/models`, `/v1/decisions`, `/v1/systemone`),
    errors, limits, batching, measured rates. Read it before touching
    `src/deciders/nuclis*.ts`; it wins over anything written here.
  - `docs/reference/laya.md`: the models' input contract, budgets,
    calibration.
- **TypeSafe Jev**: `POST https://api.typesafe.ai/v1/systemone` with a
  bearer key; the request and answer shape above; model `jev-latest`
  (answered as `jev-1.13.0` on 2026-10-02).
- **clef-flash**: the card at https://huggingface.co/Cloudflare/clef-flash
  and nuclis `TODO.md` § MODL-34 (how nuclis will run it, the image input
  it will accept). Decision Dungeons reaches it only through nuclis.

## Goals and non-goals

Goals:

- Compare deciders on the same seeded cases, in a UI and headless.
- Keep the TypeSafe Jev integration alongside nuclis and built-in
  baselines, switchable from a config page.
- Take any decision model nuclis adds, with no code change here.
- First dungeon: autopilot driving, keeping the reference simulator's look and feel,
  rewritten rather than copied.

Non-goals (for now): hosting, accounts, payments, play credit, mobile-first
work beyond what the driving UI already does, training models.

## Stack

- **Bun 1.4** (1.4.2 installed): `bun install`, `bun test`, `Bun.serve`
  with HTML imports for the dev server and its hot reload, `bun build` for
  production, `bun:sqlite` for the text dungeons' cases. No npm, no Vite.
- **TypeScript, strict**, run directly by Bun. The decision contract, the
  dungeon interface, and the driving state get real types; the reference simulator's
  implicit shapes (state, candidates, answers) were its main source of
  validation code.
- **three.js** (0.183.2, as the reference simulator) for the driving dungeon; Phosphor
  and game-icons.net icons on the gate, lobbies, and settings, lucide in
  the play views; Fraunces and DM Sans, bundled (*Decisions*).
- **Biome** for formatting and linting (one binary, TypeScript-native, no
  plugin stack), `tsc --noEmit` for types, `bun test` for tests.

## The decision contract

The request and response are Jev's shape, which the nuclis API also
reads and writes. That is the interface every decider speaks:

- `Request`: `{ state, questions: { [id]: { type, instructions, criteria } } }`,
  `type` one of `choice`, `score`, `noul`.
- `Request.images`: pictures as base64 data URLs (png, jpeg, webp, gif), 1
  to 8, at most 3 MiB of base64 in all, read before the state. Only a
  model whose `ModelInfo.images` is set sees them (nuclis: its
  `nuclis.images`; random answers without looking); TypeSafe refuses a
  request with images (`rejected`), and a call batches only requests with
  the same images.
- `Answer`: Jev's fields (`choice`/`probabilities`/`confidence`, `score`,
  `noul`) plus an optional `debug` object (logits, temperature, tokens
  read, state kept) that only the debug sidebar reads.
- `Decision`: `{ answers, usage, timings, debug }`.

```ts
interface Decider {
  id: string;                      // "nuclis", "typesafe", "rule", "random"
  label: string;
  models(): Promise<ModelInfo[]>;  // nuclis: from GET /v1/models
  status(): Promise<DeciderStatus>;// configured, reachable, version, pricing
  prepare?(req: Request, model: string): Request; // budget-aware rewrite
  decide(req: Request, opts: { model: string; signal: AbortSignal; seed?: number }): Promise<Decision>;
}
```

Every caller goes through `decideWith` (`src/contract/decider.ts`), which
prepares, times, and validates: no path trusts a decider's answers.

- **nuclis**: one decider over the nuclis API (`nuclis-http.ts`, a small
  interface with `health`, `models`, `decisions` and an injected
  `fetch`). Each decision is `POST /v1/decisions?explain=1` with one
  state (logits, temperatures, tokens read, state kept, `truncated`, and
  timings feed the debug sidebar); status is `GET /v1/health`; models are
  the decision entries of `GET /v1/models` (`nuclis.kind: "decision"`;
  today `laya`, `laya-multilingual`, `clef-flash`), so a new nuclis
  decision model shows up in the picker by itself. Its `nuclis.packs`
  picks the calling pattern: a packing model (Laya) takes up to 64 states
  per call and a 20 s bound per call; any other (clef-flash) gets one
  state per request, at most two requests in flight per model in the
  process, and a bound of nuclis's 300 s queue wait plus 8 ms per
  estimated sequence token (`Decider.batches`, `Decider.timeoutMs`). An
  entry without `packs` is listed unavailable. `422` is `rejected` with nuclis's code and
  message; `529` is retried with exponential backoff (4 retries from
  0.1 s), then `unavailable`; a refused connection is `unavailable`,
  "nuclis serve is not running at …". The rewrite
  proven in the reference simulator (each option carries its own facts, situational
  instructions first, bulky context last) is split by who knows what: the
  dungeon writes option facts and orders instructions in the request every
  decider gets, since it costs Jev nothing; nuclis's `prepare` does the
  dungeon-agnostic part, moving bulky state fields last (*Decisions*).
- **typesafe**: Jev over HTTPS, the key from the server's config, priced.
- **rule**: each dungeon's fixed baseline, deterministic.
- **random**: seeded uniform choice; the floor. Each answer is drawn from
  a hash of the run's seed and the request, so it keeps no state.

A dungeon never names a decider; a decider never knows a dungeon.

## Layout

```
decision-dungeons/
  src/
    contract/      request, answer, decider, API types; validation; decideWith
    deciders/      nuclis.ts, nuclis-http.ts, typesafe.ts, random.ts, registry.ts
    lib/           seeded randomness (the reference simulator's mulberry32,
                   exactly); png.ts, a minimal palette PNG writer
    server/        Bun.serve: app.ts (API), config.ts, cases.ts (case sets in
                   SQLite, the generators' registry), assets.ts (models,
                   textures, draco, the driving worker), icons.ts, log.ts,
                   main.ts
    dungeons/
      dungeon.ts   the Dungeon interface; turn.ts one turn; run.ts a whole
                   headless run and its RunResult; registry.ts
      crossing/    the stop-line quiz: crossing.ts, view.ts (card view)
      text/        the text dungeons' shared parts: cases.ts (case and set
                   types, picking by seed), text-dungeon.ts (the builder,
                   scoring), view.ts (the document card), vocab.ts
      inbox/       inbox.ts (levels, rule), generate.ts, text.ts (mail in
                   four languages, digest paragraphs)
      tickets/     tickets.ts, generate.ts, text.ts
      logs/        logs.ts, generate.ts
      tower/       Night Tower: sim.ts (traffic, runway, rules), tower.ts
                   (levels, request, rule, outcome), ui/ (stage.ts,
                   scene.ts, tower.css)
      oracle/      The Oracle: generate.ts (days, the hidden formula, the
                   draws), oracle.ts (levels, presentations, rule,
                   scoring), score.ts (truth gap, Brier, calibration),
                   view.ts (the day and the reliability diagram)
      undercroft/  map.ts (seeded maps, breadth-first search), picture.ts
                   (tile pictures), undercroft.ts (levels, request, rule),
                   view.ts
      evensong/    music.ts (keys, chords, the rules, the planning
                   organist, tunes), evensong.ts, view.ts (two staves),
                   organ.ts (Web Audio, browser only)
      driving/
        world/     geometry, grid (town, city), highway, road, reroute
        sim/       simulation, vehicle, traffic, collisions, courtesy,
                   rules, navigation, perception, plan (candidates)
        decide/    state, request, selection, rule
        driving.ts the dungeon: levels (worlds and checks), turns, outcome
        scenarios.ts the scenario levels and their verdicts
        ui/        stage.ts (the full-screen view), sim.worker.ts,
                   playback.ts, protocol.ts, scene/ (three.js), minimap,
                   inspector, driving.css
    ui/            gate, lobby, settings (config-page), play (card view and
                   stage hook), debug sidebar, autopilot picker, sky, icons,
                   topbar, dungeon-art, store, api, style.css
    cli/           eval.ts: `bun run eval` and `bun run check`; seed.ts:
                   `bun run seed`
  tests/           contract, deciders (stubbed nuclis API), nuclis-live,
                   server, log, crossing, driving, driving-ui, text, tower
  scripts/         browser-check, driving-check, tower-check, frame-probe,
                   driving-reference (vs the reference simulator), render-icons
  public/          models, textures, draco, icons, with licenses
  NOTICE.md
```

The dungeon interface keeps the simulation headless and deterministic:

```ts
interface Dungeon<Run> {
  id: string; title: string; levels: Level[];
  create(seed: number, level: string): Run;
  render?(run: Run): Promise<void>; // async work before each observe (a picture)
  observe(run: Run): { request: Request; resolved?: Answers }; // local answers when one option
  apply(run: Run, answers: Answers): void;
  advance?(run: Run): void;       // turn-based: time to the next decision
  step(run: Run, dt: number): void; // real time
  outcome(run: Run): Outcome;     // finished, passed, violations, metrics, per-decision records
  rule: Decider;                  // the dungeon's baseline
}
```

## Server and config page

- `GET /api/deciders`: each decider, its status, its models.
- `GET /api/config`, `PUT /api/config`: the autopilot defaults per dungeon,
  the nuclis API's URL (default `http://127.0.0.1:8000/v1`; http(s), no
  credentials, query, or fragment), the TypeSafe key. Stored in
  `~/.decision-dungeons/config.json` (mode 600); the key is write-only from the
  browser: reads return only whether it is set. Environment variables
  (`TYPESAFE_API_KEY`, `NUCLIS_URL`) override the file.
- `POST /api/decide`: `{ dungeon, decider, model, request }` →
  `Decision`. Bounded body size, a timeout per decider, at most three in
  flight, errors typed (`unconfigured`, `rejected`, `unavailable`,
  `timeout`, `invalid_answer`) as `{ error: { code, message } }`.
- Bound to `127.0.0.1` (port 7000, `DECISION_DUNGEONS_PORT`). Every API
  route requires a loopback `Host` header; writes must be same-origin
  `application/json`, because the config names where the server sends
  decisions.

## The gate, the lobbies, and the debug sidebar

- The gate (`/`) shows every registered dungeon as a gateway; a dungeon
  without art in `src/ui/dungeon-art.ts` gets a generic one. Its lobby
  (`/d/<id>`): pick a level, an autopilot (decider and model, the
  unconfigured ones shown disabled with the reason), a seed; play. A
  dungeon either plays in the shared card view (Crossing) or supplies a
  full-screen stage (driving; `src/ui/views.ts`).
- The HUD names the active autopilot ("nuclis · laya-multilingual engaged").
- Debug sidebar (N): the generalized version of the one built in the reference simulator:
  time split (model load, tokenize, encode, process, HTTP), tokens and
  truncation, one card per question with each option's text,
  probabilities, logits, the pick, and the recent decisions. Fields a
  decider does not report are omitted, not faked.

## Dungeon 1: autopilot driving

Kept from the reference simulator: the look of the HUD, minimap, cameras, candidate paths
and the JSON inspector; the three worlds and Interstate 08; sampled
candidate paths and their measurements; the safety brake; Jev's request
shape; the headless trip and stop-line checks.

Restructured:

- `simulation.js` (1,471 lines) splits into world, traffic, vehicle, and
  decision-state modules with typed state; `main.js` (1,104 lines of HTML
  strings and globals) becomes small UI components over a single store.
- The whole run plays in a Web Worker in the browser (planning would
  otherwise block frames); the page renders interpolated snapshots.
- Hosted pieces (OAuth, play credit, Durable Objects, Cloudflare Worker)
  are left out.
- **A turn-based mode**: simulated time pauses while the autopilot
  decides, so a slow decider (clef-flash, about 1–3 s) plays the same
  game as a fast one and latency never enters the score. It is the
  default in the browser (*Decisions*); T switches to real time.
- **An evaluation mode** (`RunOptions.evaluation`, the lobby's switch,
  `--evaluation`) that turns the safety nets off, because the reference simulator showed
  they make any decider arrive (random arrived on 12 of 12 trips): the
  safety brake, the collision exclusion in the planner's and the
  selection's filters, and the traffic taper (candidates are sampled up to
  the road's own bound, not the following speed), so in-lane paths fast
  enough to hit the car ahead are offered and the decider must refuse
  them; a stop is offered at a junction whose rules make the player yield
  (*Decisions*). Every `RunResult` records `evaluation`.
- Scenario checks are first-class levels of the driving dungeon
  (`scenarios.ts`): each places the car, clears or scripts the other
  agents, and judges one skill against a stated bound, run by every
  decider:
  - `stop-line`: a red light, no traffic; stop with the car's center
    within 3.5 m of the line (bumper short of it), then go on green.
  - `stop-sign`: a cross-street car reached the stop sign first and waits
    (frozen) until a second after the player's full stop; stop, let it
    go, then cross. Entering before it passed fails; through within 60 s.
  - `merge`: from the on-ramp at 12 m/s into six interstate cars 30 m
    apart with one 80 m gap, timed to meet a car averaging 85% of the
    ramp's limit; on the interstate without contact within 45 s.
  - `blocked-lane`: a car stands still 50 m ahead on the first 70 m
    straight; stop with the bumper within 2.5 m without contact (at rest
    for 3 s), or pass it cleanly.
  - `off-road`: the car starts 10–14 m beside its route, off the asphalt
    and 1.5 m clear of buildings; back on the route (on the asphalt,
    within 2.5 m of it) within 25 s without contact.

**Proving the port.** The rule decider is deterministic, so it is the
oracle: for seeds 1–4 in each world and for the stop-line check, the port
and the reference simulator (the commits `NOTICE.md` records) must arrive
alike, with the same violations and stop distances within 0.1 m.
Differences are explained or fixed before the UI work. Done: every run
is bit-identical (*Progress*, milestone 2); `scripts/driving-reference.ts`
keeps it so.

## Dungeon 2: Night Tower

The surprise 3D dungeon (`src/dungeons/tower/`): the decider works the
tower of Port Alder International's single runway 27 after dark.

- **The simulation** (`sim.ts`): arrivals are handed over on a 10 nm,
  three-degree final; at 2.5 nm the tower must clear each to land or send
  it around. Departures taxi out to the holding point; the head of the
  queue is offered to the tower until it is released (asked again every
  10 s while held). Fixed 50 ms steps and seeded schedules (operators,
  types, wake categories, spacing); runway occupancy is computed by
  stepping a copy of a flight alone, so the times the request states are
  exact. Incidents: landing with the runway occupied (the crew goes around,
  counted), a take-off roll within 120 s of a heavy's, and in low
  visibility a runway clear less than 45 s before a landing.
- **The request**: the rules, the runway's occupants and when each
  clears, arrivals with their threshold times, the departure queue, and
  the decisive numbers again in each option's text (`land`/`go_around`,
  `take_off`/`hold`). **The rule**: exact timing arithmetic with small
  margins. **Levels**: quiet evening, rush hour, low visibility, and the
  go-around check (a jet rejects its take-off and stops at 650 m as an
  arrival reaches 2.5 nm: send it around, then land it). A shift passes
  with every flight handled and no incident.
- **The stage** (`ui/`): the airfield built in code at blue hour (runway
  markings, edge, centreline, threshold and end lights, an approach light
  system with its sequenced flasher, PAPI, taxiway and exits, stop bar,
  floodlit apron, terminal, hangars, the tower, the town's lights), and
  low-poly airliners with liveries, cabin windows, navigation lights,
  strobes, beacons, and landing-light beams. Flight strips, a radio
  transcript in ATC phraseology, the question on screen, tower-cab /
  final-approach / overview cameras (C), time at 1x, 4x, 16x (1-3), the
  shared debug sidebar (N). The simulation runs on the main thread in the
  same 50 ms steps as headless and stops at each question, so a browser
  shift is the headless one (`tests/tower.test.ts` asserts it).

## Dungeon 3: The Oracle

Every other dungeon's case has a right answer. Here each case has a
**true probability**, so a decider's probabilities are scored against
the truth itself, apart from luck: the one thing a labelled dataset
cannot measure. nuclis says Laya's probabilities are calibrated
likelihoods and clef-flash's are an uncalibrated softmax; the cascade
(*Progress*) failed because laya-multilingual's confidence did not track
its errors. The Oracle measures both directly.

- **The world.** Harborline's harbour runs a morning ferry. Each case is
  one day's harbour log, and the question is "Will the morning ferry
  sail?" (`noul`). A hidden formula (fixed code of `oracle@1`, so every
  case set asks about the same world) turns the day's facts into a real
  chance: a logistic over wind and gusts, swell, visibility and fog,
  the wind's direction against the harbour mouth (an interaction), crew on
  duty against crew required, an engine notice, a port-authority
  advisory, and the captain's record; then the outcome is drawn from that
  chance with the case's own seeded generator. The case stores both the
  true probability and the outcome (`TextCase.odds`, beside `truth`, in
  its own column of the case store). The formula's scale was set so the
  chances spread over the whole range (mean 0.51; no more than a quarter
  of days within 0.1 of certain).
- **What the decider reads.** The log, and in the question's instructions
  the harbour master's handbook: the formula's directions in words ("high
  gusts rarely let her sail; a westerly at the mouth is worse than the
  same wind from the east"), never its weights. The best a reader can do
  is approach the true chance.
- **Levels.** `numbers`: the facts as a table. `log`: the same facts in a
  day's prose log, among routine entries. `scattered`: the facts across
  several notices, some corrected by a later one. `contradiction`: the
  captain's note disagrees with the instruments, and the formula follows
  the instruments (the handbook says so). The four play the same days
  (`log`, `scattered`, and `contradiction` are `casesOf: "numbers"`), so
  a seed's runs differ only in how the facts are shown. `many` (tagged `many-questions`): several questions
  about each day, each with its own true chance (sails at all, sails on
  time, carries over 200 passengers, the café opens). Cases live in a case
  set like the text dungeons' (`bun run seed`), generator `oracle@1`.
- **Scoring.** Per run: `truth_gap`, the mean |p − true p|; Brier against
  the outcomes beside the **oracle's Brier**, that of the true
  probabilities (the floor no decider beats in expectation); skill
  against climatology (the run's own base rate; omitted when every
  outcome was the same); log loss (p clamped 1e-4 from 0 and 1); and
  calibration (`Outcome.calibration`), the outcome rate per fifth of the
  decider's p and the mean true p per bin, which `bun run eval` pools
  over seeds. The `many` level pools its four questions. A run passes
  when its truth gap is at most a bound set from the measured deciders
  (*Decisions*). Truths are never labels a model
  wrote: the formula and the draw are seeded code.
- **The rule** is a deliberately partial forecaster: the best logistic on
  the mean wind and the swell alone (σ(3.05 − 0.109·wind − 0.76·swell),
  fitted against the true chances of 6,000 days; expected truth gap
  0.115, a constant forecaster's 0.29), read off the table or the text,
  the latest correction winning. On `many` it answers the other questions
  as half its sailing chance, the café at even odds. The oracle itself is
  a reference column in results (`oracle_brier`), not a decider.
- **The view.** The day's log on the left; on the right the decider's p,
  the true p, and the outcome, then a live reliability chart over the run
  (follow the `dataviz` skill) and the truth gap so far.

## Dungeon 4: Undercroft, a dungeon crawler

The project's name made literal, and the first dungeon whose decisions
compound: each move changes the next situation, as an agent's does.

- **The world.** A seeded grid of corridors (11×11 or 13×13 tiles, cut
  as a maze by a seeded depth-first walk, some walls knocked through for
  loops): walls, coloured keys and their locked doors, static monsters
  (a move that ends next to one costs one of three hit points), the exit
  stairs (the floor tile farthest from the start), and some gold.
  Generated from the seed so the exit is always reachable without a hit
  point lost; the optimum, the fewest such moves over (position, keys
  held), is known by breadth-first search. Doors sit on the way out of a
  loop-free maze with each key off the way before its door, so every key
  is needed in turn; monsters are placed one by one where they lengthen
  the safe optimum most (4–14 moves on seeds 1–6).
- **The decision.** One per turn: `move`, a `choice` of north, east,
  south, west, each option saying only the direction (the map carries the
  facts). Turn-based through `Dungeon.advance`, as driving and Night
  Tower; no case set, the map comes from the seed.
- **What the decider sees.** Text levels: an ASCII map with a legend, the
  hero's position, keys held, hit points, and the goal. Picture levels:
  the same map as a tile picture (`Request.images`), the facts stated in
  text kept to hit points and keys. Pictures are drawn in TypeScript, not
  in a browser: 28-pixel tiles of small sprites (hero, key, door,
  monster, stairs, gold) in one fixed palette, encoded by a minimal PNG
  writer (`src/lib/png.ts`: 8-bit palette, CRC-32, zlib through
  `CompressionStream`, which Bun and browsers both have), so the browser
  and `bun run eval` draw the same bytes and no Chromium is needed at play
  time. Encoding is async, so the dungeon draws the picture in
  `Dungeon.render`, which `playTurn` awaits before each observation.
- **Levels.** `corridors` (an 11×11 maze with a few loops), `keys` (11×11,
  the gold door then the red), `monsters` (13×13 with loops, a safe way
  round), `fog` (13×13; only the tiles within two steps, Chebyshev, are
  shown, the rest as remembered or `?`), `picture` (the keys maps as a
  picture only, tagged `images`), `picture-both` (picture and text); the
  three keys levels play the same maps for a seed.
- **Scoring.** Reached the exit, steps against the optimal, efficiency,
  bumps into walls and locked doors (violations), hit points lost, gold;
  a turn limit of three times the optimal; passed when the exit is
  reached within twice the optimal steps without dying.
- **Deciders.** The rule is the breadth-first planner on the map the
  request shows (the optimum when the map is known; under fog it plans
  through unseen tiles as open and heads for the nearest one until the
  stairs are seen); random is the floor; the cascade screens with Laya and
  sends unsure moves and every picture to clef-flash.
- **The view.** The map drawn from the same tiles at a larger scale, the
  hero's trail, the decider's probabilities as arrows around the hero,
  HUD with keys, hit points, steps against the optimal.

## Dungeon 5: Evensong

The user asked for one more dungeon "that can show how decision models
can be used in a very creative way". Evensong: the autopilot is the
organist, harmonizing a hymn tune one chord under each melody note, and
the play view plays what it chose on an organ.

- **The tune.** Seeded, in C, D, F, or G major: four-note phrases that
  begin on a note of the tonic chord, end each inner phrase on a note of
  V, and close on the tonic from a note of V; the melody keeps its
  direction more often than not and never see-saws. A tune is kept only
  when a flawless harmony exists.
- **The decision.** `chord`, a `choice` among the chords whose tones hold
  the note: I, ii, iii, IV, V, vi in root position or first inversion
  ("6"), and V7 in root position. Each option says the chord's quality and
  notes, its bass note (placed nearest the last bass, E2 to A3), how the
  bass moves, and the interval between the melody and the bass, so every
  fact a rule needs is in the request.
- **The rules of the loft**, each a fault: begin on I in root position;
  consecutive fifths or octaves between melody and bass while both move;
  retrogressions (the dominant back to ii or IV, ii anywhere but the
  dominant, IV to vi or iii); the leading tone in both melody and bass; a
  tritone leap in the bass; a V7 seventh in the melody that does not fall
  to the third; each inner phrase ends on V (a half cadence); the hymn
  ends V or V7, then I, roots in the bass. Judgement is these rules,
  never a model's taste.
- **Levels.** `phrase` (4 notes), `hymn` (8), `chorale` (12), each with
  the rules written in the question, and `by-heart`: the hymn tunes with
  no rules stated, to ask whether a model knows harmony untold.
- **Scoring.** A run passes with no fault; metrics count chords right and
  each kind of fault, and root-position chords.
- **The rule** is an organist who plans the whole tune by dynamic
  programming over (note, chord, bass pitch): the fewest faults, then the
  fewest repeated chords and inversions, reading the tune and the harmony
  so far back from the request.
- **The view.** The hymn on two staves (melody above, bass below, the
  numeral under each chord, faults in red), how sure the organist was of
  the last chord (its probabilities), and an organ (`organ.ts`, Web Audio,
  four voices with simple inner-voice filling) that plays the hymn, or
  each chord as it lands, once a person clicks.

## Headless runs

```sh
bun run eval --dungeon driving --decider nuclis --model laya-multilingual --seeds 1-4
bun run check driving/stop-line --decider rule
```

JSON lines per run and a markdown table, the same results types the UI
shows.

## Provenance

`NOTICE.md` records that the driving dungeon is a rewrite of the
reference simulator, used with permission, and lists the
assets and their licenses: the Tesla Model Y by 763468712 (CC BY 4.0,
attribution required), Poly Haven models, textures and sky (CC0), the
three.js Ferrari (MIT). Asset license files travel with the assets.

## Milestones

1. **Skeleton.** Bun server, contract, the four deciders, config store and
   page, start screen, debug sidebar, `bun test` for the contract and
   deciders (a fake `nuclis` binary as in the reference simulator's tests).
2. **Driving, headless.** World, sim, decision state, rule baseline,
   checks, `eval`; matched against the reference simulator as above.
3. **Driving, UI.** The scene and HUD at the reference simulator's look, the inspector,
   evaluation mode, scenario levels.
4. **Text dungeons.** Inbox, ticket triage, logs: synthetic cases with
   known answers, scored per decision, levels for long inputs, numbers
   against thresholds, and other languages. The cases live in SQLite at
   `~/.decision-dungeons/dungeons.db`, written by a seed script: a seeded
   generator of realistic emails, tickets, and logs whose answers follow
   from how each case was built (never from a model), which can add more
   cases at any time without changing what a run already played
   (*Decisions*).
5. **A second 3D dungeon**, designed here (the user asked for a
   surprise): Night Tower (*Dungeon 2*).
6. **Vision**, now that nuclis serves clef-flash with images. Receipts
   (documents) is the first; the others below follow. Images are rendered from seeds (the three.js scene, or
   seeded HTML through headless Playwright) and stored as fixtures, so
   runs repeat.
   - **Driving, seeing instead of being told**: the camera frame beside
     the state, or instead of it. A *blind state* level drops facts from
     the JSON (the signal colour, a pedestrian) so the frame must supply
     them; comparing state only, frame only, and both shows whether
     vision adds information or only cost. Candidate paths drawn and
     labelled in the frame (v0…v6) let the autopilot choose by looking.
   - **Documents**: receipts and invoices to approve, reject, or route,
     with amounts read from the image (the numbers question again).
   - **Dashboards beside logs**: a chart screenshot with the log text,
     "is this an incident?"
   - **Interface screenshots**: "is this page broken?", "which control
     completes the task?"
   - **Inbox with rendered emails**: phishing judged from the rendered
     message, not only its text.
   Costs to plan for: 8–1,024 image tokens per frame (about 576 for
   768×768), so vision levels run turn-based; Laya and the rule cannot
   see images, so image-only levels compare clef-flash with the best
   state-only decider.
7. **The Oracle** (*Dungeon 3*): calibration against true probabilities.
8. **Undercroft** (*Dungeon 4*): a dungeon crawler, text maps and tile
   pictures.
9. **Evensong** (*Dungeon 5*): the user's second surprise, harmony at the
   organ.

## Decisions

- Named **Decision Dungeons**: the repository `~/Code/decision-dungeons`, the
  config directory `~/.decision-dungeons` (2026-10-02).
- `~/Code/decision-dungeons`, local only: no remote, nothing pushed (2026-10-02).
- Bun 1.4, TypeScript strict, Biome (2026-10-02).
- nuclis is reached only through `nuclis serve`'s HTTP API, whose contract
  is nuclis's `docs/reference/api.md`; the subprocess transport, the
  binary path, and the backend setting are gone. The config holds one
  nuclis setting, the API's URL (`NUCLIS_URL` overrides; default
  `http://127.0.0.1:8000/v1`); the old `nuclis.bin` and `nuclis.backend`
  keys are ignored and dropped on the next write. The user runs the
  server; the project never starts it (2026-10-02).
- clef-flash arrives through nuclis (MODL-34), text first, images later;
  Decision Dungeons adds the turn-based mode for it and plans the vision
  dungeons as milestone 6 (2026-10-02).
- The nuclis decider calls a model as its `GET /v1/models` entry says
  (`nuclis.packs`, which nuclis added for this), never by model name or
  `head_max_len`, and with no fallback for a server that does not send it
  (the user: there are no older servers). A model that does not pack
  (clef-flash: one sequence per state, linear in tokens) gets one state
  per request with every question in it, at most two requests in flight,
  and a timeout from the work (queue wait plus tokens), so Laya keeps its
  short bound and a hang still surfaces fast (2026-10-03).
- Each text dungeon has an `all-questions` level asking every one of its
  questions about each case in one request (Inbox: phishing and route;
  Tickets: team, urgency, refund; Logs: page and cause, with a `none`
  cause for windows with nothing to page for); a case is right only when
  every answer is. Levels carry tags (`many-questions`, `long-input`) that
  name what they test; the dungeon stays decider-agnostic and the lobby
  renders them as "for clef-flash" (2026-10-03).
- A case set grows by whole new levels: a write whose set holds every
  stored level case for case and adds levels inserts those levels'
  cases (`extended`), and the server adds a generator's new levels to an
  existing base set the same way. A run of an old level plays exactly the
  cases it played before; the set's hash changes with its new levels, so
  results from before name the earlier hash. Generators that gained a
  level are `@2` (2026-10-03).
- Next: The Oracle, then Undercroft (*Dungeon 3*, *Dungeon 4*), before
  the remaining vision dungeons; the user asked for both after the
  cascade's measurements (2026-10-03).
- Model ids may hold `:` and `@` (a cascade's); dungeon, set, and decider
  names keep the stricter pattern (2026-10-03).
- Pictures come from the case set, never from a model or the network: a
  generator writes each pictured case's page (`TextCase.source`, seeded
  HTML), and the store renders it once, when the set is written, in
  headless Chromium (`src/server/render.ts`, injected so tests use a fake
  PNG). The set's hash covers the source, not the PNG, so a set reproduces
  exactly whatever renders it, and sets without pictures keep their hashes
  (2026-10-03).
- The first vision dungeon is Receipts (the user's choice): expense
  receipts reimbursed against a travel policy (trip dates, a limit per
  kind of expense, no alcohol), their total read among four printed
  candidates, their currency and kind. The policy levels ask the same
  receipts as data, as a picture, and as both (`casesOf`), so a run shows
  whether seeing adds anything to reading. Levels with pictures say so
  (`Level.images`: `only` or `with-text`); the lobby disables models that
  cannot see them, and the rule where the picture is all there is
  (2026-10-03).
- The settings page's per-dungeon list scrolls inside its card past the
  viewport's height, so the page still never scrolls as dungeons are
  added (2026-10-03).
- The cascade is a decider of its own ("Cascade", `src/deciders/cascade.ts`)
  over the nuclis decider, not a nuclis model: its pairs are every
  available model that packs (screener) with every one that does not
  (judge), from `GET /v1/models`, and its model id is
  `screener:judge@threshold`, so every result names the pair and the
  threshold. The screener's answer stands when its least sure question's
  top probability reaches the threshold and the state was not cut; a
  request with images goes to the judge alone. The lobby offers each pair
  at 0.85; `bun run eval --threshold` sweeps others. The threshold has no
  settings-page field (the page is approved as it is, and the model id
  already carries it) (2026-10-03).
- The Oracle's hidden formula is fixed code of `oracle@1` (its weights
  are constants), so every case set asks about the same world; only the
  days and the draws are seeded, each case from its own generator, so a
  case never moves when more are written. Its `log`, `scattered`, and
  `contradiction` levels play the `numbers` days (`casesOf`), so the
  presentations compare on equal cases (2026-10-03).
- `TextCase.odds`, the true probability per question, is stored in its own
  column (schema version 3, `ALTER TABLE … ADD COLUMN`); the set's hash
  covers it only when present, so sets without odds keep their hashes and
  the user's base sets gain the Oracle in place (2026-10-03).
- Forecast scoring lives in the result, not the table: `Outcome.calibration`
  (five bins of the decider's p, each with its count, mean forecast,
  outcome rate, and mean true p) beside `truth_gap`, `brier`,
  `oracle_brier`, `skill` (against the run's own base rate, omitted when
  every outcome was the same), and `log_loss` (p clamped 1e-4 from 0 and
  1, since deciders round to four places). `bun run eval` prints the bins
  pooled over seeds below its table. The text builder takes `score` and
  `record` hooks for dungeons whose cases have no single right answer
  (2026-10-03).
- The Oracle passes a run at a truth gap of 0.10 or less
  (`PASS_TRUTH_GAP`): under the best wind-and-swell forecaster's expected
  0.115 (6,000 days), so a pass means reading more of the day than wind
  and swell. Measured on seeds 1–4 (*Progress*, milestone 7): the rule
  passes 4 of 20 runs on the luck of the draw, no model passes any (the
  best, clef-flash, at 0.16–0.20 on the readable levels); at 0.15 the
  rule would pass 19 of 20 and the bound would say nothing (2026-10-03).
- Undercroft's pictures are drawn by `src/lib/png.ts` through
  `CompressionStream`, as planned; checked once that Bun 1.4.2 and
  Chromium (playwright-core 1.63.0) deflate the same 200 KB to the same
  5,991 bytes, and a test pins the keys map's picture by hash. Encoding is
  async while `observe` is not, so the interface gained
  `Dungeon.render(run)`, awaited by `playTurn` before each observation;
  `observe` refuses a picture drawn for an earlier turn (2026-10-03).
- Undercroft's sizes: `corridors` and the keys maps 11×11 (optimum about
  40–60 moves; at 13×13 the keys maps took 66–74, which made a clef-flash
  run 200 turns long), `monsters` and `fog` 13×13. Monsters go where they
  lengthen the safe optimum most: placed at random beside the way, they
  lengthened it on 1 of 6 maps. Under fog, runs are scored against the
  optimum on the whole map, and the rule explores (2026-10-03).
- The card view's pause between turns is per dungeon (`dungeonPace`):
  Undercroft 280 ms (its turns are many and small), Evensong 900 ms, the
  others 700 (2026-10-03).
- The user asked for one more dungeon showing a creative use of decision
  models: Evensong (*Dungeon 5*), harmony at the organ judged by stated
  rules, with a Web Audio organ in the browser (no dependency, no asset;
  audio starts only on a click). New dungeons' marks are Phosphor icons,
  already a dependency (2026-10-03).
- Scope: the user asked for the whole plan end to end, a second 3D
  dungeon of this project's design (milestone 5), and the text dungeons'
  cases in SQLite under `~/.decision-dungeons` with a seed script that can
  generate more (2026-10-02).
- Dependencies: lucide 0.577.0 (icons in the play and driving views, as
  the reference simulator; the other pages use the icons below); dev only TypeScript
  7.0.2, Biome 2.5.15, @types/bun 1.4.2 (2026-10-02), and
  `playwright-core` 1.63.0, which `bun run seed` needs to render the
  vision dungeons' images and the browser checks use (2026-10-03; until
  then it was found through `NODE_PATH`).
- **Crossing**, a small text dungeon, ships with milestone 1 so the
  skeleton plays end to end before driving: drive or stop at a signalled
  line, a known answer per seeded case, levels for the signal, the
  distance, and both (2026-10-02).
- Every lobby selects nuclis · `laya-multilingual` unless the settings
  page saved another default for that dungeon; when nuclis is not ready
  it falls back to the first ready decider (rule, random, nuclis,
  TypeSafe) (2026-10-02).
- The text dungeons are Inbox, Ticket triage, and Logs, built on one
  builder (`src/dungeons/text/`): each case one decision, scored against
  known answers (a noul right at 0.5, a choice by option, a score by the
  nearest level; Brier and mean absolute error as metrics), 20 cases a
  run, passed at 90% right. Their cases live in SQLite (`bun:sqlite`, no
  dependency) at `dungeons.db` in the config home: immutable named sets,
  each with its generator id, seed, and a content hash every result
  records (`RunResult.caseSet`); a run picks its cases from one set by
  seed. Generators are seeded code, so labels follow from construction and
  `bun run seed` reproduces a set exactly; the server writes each base set
  on first use. The world is a fictional company (Harborline), with real
  service names only where real mail carries them (2026-10-02).
- The case store runs SQLite in WAL mode with `synchronous = NORMAL`, a
  5 s busy timeout, an in-memory temp store, a 16 MB page cache, 256 MB of
  memory-mapped reads, a 64 MB journal cap, and `PRAGMA optimize` on
  close; the schema is versioned in `user_version` (migrations in
  `src/server/cases.ts`). Its use is many readers (the server, evals) and a
  rare bulk writer (`bun run seed`), sometimes in two processes at once:
  WAL lets them run together, and a set lost to a power cut is rewritten
  exactly by its seed. Measured on the M4 Pro with 3,500 cases: a level
  loads in 7.1 ms (8.6 before), a bulk write takes 47 ms (34 before);
  `tests/text.test.ts` reads while another process seeds (2026-10-02).
- The text dungeons' gate marks are Phosphor icons (envelope, ticket,
  terminal), already a dependency, rather than new game-icons.net
  downloads (2026-10-02).
- The second 3D dungeon is Night Tower, an airport tower at night: its
  decisions are timing against stated numbers (the weakness the stop
  line showed), it renders from code with three (no new dependency or
  asset), and its simulation is light enough to run on the main thread
  rather than in a worker (2026-10-02).
- `RunResult.truncated` counts decisions whose state the model cut, from
  the decider's own report (2026-10-02).
- The short-budget rewrite is split. Dungeons put each option's facts in
  its text and situational instructions first in the one request every
  decider receives (the reference simulator showed this costs Jev nothing, and comparisons
  stay on the same input); nuclis's `prepare` does only the
  dungeon-agnostic part, moving top-level state fields over 400 characters
  to the end, smallest first (2026-10-02).
- The driving stage defaults to turn-based play rather than real time:
  a browser run is then exactly the headless run of the same seed, and a
  slow decider plays the same game (2026-10-02).
- Manual driving (WASD, J, Space) and the reference simulator's touch controls are not
  in the plan's milestones; whether to port them is the user's call, not
  yet made (2026-10-02).
- Scenario levels may script traffic (`Simulation.frozen`) and offer a
  stop at the line while the junction's rules make the player yield
  (`Simulation.yieldStops`, the `yield_right_of_way_within_2_5m` stop
  reason). The reference simulator never offered that stop, and it arises in default
  trips (town 4 and city 4 under the rule, three decisions each), so
  default trips leave it off to stay bit-identical; scenario levels and
  evaluation mode turn it on. The rule, unchanged on the road, takes the
  path ending nearest the way back when the request carries
  `recovery_distance` (only in recovery, which the experiment's trips
  never entered), so it passes `off-road` and the port stays identical
  (2026-10-02).
- Evaluation mode turns off three nets, not the two first planned: the
  safety brake, the collision exclusion, and the traffic taper. Measured
  before deciding: with only the first two off, no colliding in-lane path
  was ever offered (town and city seeds 1–4 under the rule: every
  colliding moving candidate was off the road, already excluded), so the
  mode changed nothing but the brake. The taper is lifted by sampling
  under `Envelope.roadMax` (limit and destination) instead of
  `planningMax`; default runs are untouched and stay bit-identical. The
  rule stays the experiment's rule (the port's oracle) and is measured as
  it is (2026-10-02).
- A fifth decide error, `unavailable` (cannot reach the decider, HTTP 5xx,
  cancelled), beside `unconfigured`, `rejected`, `timeout`, and
  `invalid_answer` (2026-10-02).
- The server listens on `127.0.0.1:7000` (`DECISION_DUNGEONS_PORT`); API
  routes require a loopback `Host` (DNS rebinding) and same-origin JSON
  writes (cross-site requests), since the config page sets where the
  server sends decisions (2026-10-02).
- The UI fetches nothing from the network at runtime; its fonts are
  bundled locally from OFL packages, pinned exactly:
  `@fontsource-variable/fraunces` 5.3.0 (display) and
  `@fontsource-variable/dm-sans` 5.3.0 (text), imported from
  `src/ui/style.css` so Bun bundles the woff2 files (2026-10-02).
- The home page is a world-select gate: every dungeon a lit gateway, the
  run set up in the dungeon's lobby at `/d/<id>`; the gate and lobbies fit
  one desktop viewport without page scroll (2026-10-02).
- UI icons: Phosphor (`@phosphor-icons/core` 2.1.1, MIT, raw SVGs) for
  chrome, and game-icons.net SVGs (CC BY 3.0, by Delapouite and Lorc) for
  dungeon and decider marks, kept under `src/ui/icons/game/` with their
  credits and shown on the settings page; both are bundled as text and
  inlined by `src/ui/icons.ts`. Icons appear only where they carry meaning,
  never in front of a heading or a plain label. The app's own icon set
  (`public/icons/`: mark, favicon SVG and ICO, 180/192/512 PNGs, web
  manifest) is rendered from its SVG by `scripts/render-icons.ts`
  (2026-10-02).

- The driving scene uses three, pinned at 0.183.2 as in the reference simulator, with
  `@types/three` 0.183.1 (dev). The reference simulator's Model Y (CC BY 4.0), Poly Haven
  models and textures (CC0), and Draco decoder (Apache 2.0) are copied
  into `public/` with their license files and served read-only from
  `/models`, `/textures`, and `/draco`; the unused Ferrari is left out
  (2026-10-02).
- The driving run plays in a Web Worker (`src/dungeons/driving/ui/sim.worker.ts`,
  bundled and served at `/workers/driving-sim.js` by the server, since
  Bun's HTML bundling does not follow `new Worker(new URL(...))`); the
  page renders snapshots interpolated by wall time. Turn-based play asks
  for the next decision while the current turn's 0.3 s still plays, so a
  decider under about 0.35 s never visibly stops the car and the run stays
  exactly the headless one (2026-10-02).

## Progress

### Milestone 1, the skeleton: done (2026-10-02, commit `ae499e6`)

Delivered:

- `src/contract/`: Jev-shaped request and answer types, `parseRequest`
  and `validateAnswers` (an option not offered, a non-finite or
  out-of-range probability, a missing or extra answer: `invalid_answer`),
  `decideWith`, the single prepare-time-validate path, and the API types.
- `src/deciders/`: nuclis over the `spawn` transport (models from `nuclis
  model ls --json`, `kind: "decision"`; `--explain` fields mapped to
  `debug`), TypeSafe Jev over an injectable `fetch` (priced at $0.042 per
  million input tokens), random (seeded, stateless), and the registry;
  `rule` is the dungeon's own baseline.
- `src/dungeons/`: the `Dungeon` interface, `playTurn` (shared by UI and
  the future CLI), and Crossing with its rule and its browser view.
- `src/server/`: `GET /api/deciders`, `GET`/`PUT /api/config`, `POST
  /api/decide`; the config store (mode 600, `DECISION_DUNGEONS_HOME`,
  `NUCLIS_BIN` and `TYPESAFE_API_KEY` override, key write-only).
- `src/ui/`: start screen (dungeon, level, autopilot with disabled
  deciders and their reasons, seed), config page, play view (turn-based,
  paced 0.7 s, pause, restart, typed failure banner with retry), debug
  sidebar (N): time split, tokens, truncation, one card per question with
  option texts, probabilities, logits and the pick, recent decisions;
  unreported fields omitted. `NOTICE.md` records the reference simulator's origin and
  lucide's license.

Validated at `ae499e6` on an Apple M4 Pro (12 cores, macOS 27.0.1), Bun
1.4.2, nuclis 0.4.0-dev:

- `bun test`: 40 pass, 0 fail (contract, deciders against a fake `nuclis`
  binary and a stubbed `fetch`, config, server guards and limits, Crossing).
  `bunx tsc --noEmit` and `bunx biome check` clean. Each of the five
  commits typechecks and passes its own tests alone.
- `scripts/browser-check.ts` against the dev server with a throwaway
  `DECISION_DUNGEONS_HOME`, screenshots looked at in
  `artifacts/screenshots/` (not committed): `start`,
  `crossing-rule-{running,finished}`, `crossing-laya{,-multilingual}-{running,finished}`,
  `decision-failed` (an injected 502 shows `rejected` and its message;
  Retry finishes the run), `config`, `start-nuclis-missing` (a bad binary
  path disables nuclis with "nuclis was not found at …"). No console
  errors.
- One run each, Crossing level `distance`, seed 1, 12 cases, real local
  decisions (single runs, not a benchmark):

  | Decider | Correct | Ran the red light | Decider time per case |
  | --- | ---: | ---: | --- |
  | rule | 12 | 0 | under 1 ms |
  | nuclis `laya-multilingual` | 4 | 3 | 424–472 ms (load 376–392, encode 32–35) |
  | nuclis `laya` | 3 | 0 | 136–168 ms (load about 85, encode about 55) |

  `laya` answered stop on every case (P 0.54–0.61); `laya-multilingual`
  split drive and stop at P 0.51–0.65. Both sit near a coin flip on the
  1.0 m threshold, where the reference simulator's stop-line check separated them; the
  difference in question wording and state is worth a look once `eval`
  can run many seeds.

Not done, by design or for later:

- No real TypeSafe call was made: the key in the environment was detected
  (shown as set by `TYPESAFE_API_KEY`), but a paid call is an explicit
  command, and there is no CLI yet to make one.
- No `bun run eval` or `check` yet (milestone 2).

### Milestone 2, driving headless: done (2026-10-02, commits `e605944`, `1b2ce5a`, `bbeb8d8`)

Delivered:

- `src/dungeons/driving/`: `world/` (geometry, the town and city grid,
  Interstate 08, road polygons and occupancy, rerouting), `sim/` (vehicle
  dynamics, collisions, traffic safety, courtesy, junction rules,
  navigation, perception, the candidate planner, the `Simulation`),
  `decide/` (the decision state, the request, selection, the rule), and
  `driving.ts`, the dungeon: levels `town`, `city`, `highway`,
  `stop-line`, turn-based through the new optional `Dungeon.advance`
  (six 50 ms steps per decision, the reference simulator's headless cadence).
- The request is Jev's (candidate, road, and traffic tables) with each
  path's facts also in its option text and situational instructions
  first (*Decisions*); the rule is the reference experiment's fixed rule
  (`/tmp/deciders.mjs` then), read off the request.
- `bun run eval` and `bun run check` (`src/cli/eval.ts`) over
  `runEpisode` (`src/dungeons/run.ts`): a JSON line per run and a
  markdown table of the same `RunResult` objects.
- `scripts/driving-reference.ts`: the reference simulator's simulation and the port side
  by side with the same rule, compared at every decision.

Validated on the Apple M4 Pro, Bun 1.4.2, against the reference simulator:

- `bun scripts/driving-reference.ts all`: seeds 1–4 in town, city, and
  highway and the stop-line check (seed 42) are **bit-identical**: every
  decision's position, heading, speed, steering, and target equal with
  `Object.is`, the same decision counts (town 155, 209, 136, 185; city
  235, 139, 131, 153; highway 338, 340, 340, 341; stop line 28), all
  arriving with no collision and no violation, the stop line at 3.07 m
  (bumper 0.70 m, as the reference's own measurement for this rule) and
  resuming on green. Wall time 4–168 s per pair of runs.
- `bun run check driving/stop-line --decider rule`: pass, center 3.1 m,
  bumper 0.7 m, 29 decisions (28 to the stop and the green one).
- `bun test`: 47 pass, among them worlds per seed, the request through
  the server's parser, the rule on the stop line, and a replay with the
  random decider.

### Milestone 3, driving UI: in progress (2026-10-02, commits `36ba18e`, `8d9b72c`)

Delivered:

- The gate (`/`): a night-sky world select, every dungeon a lit gateway,
  keyboard ←/→ and Enter; each dungeon's lobby at `/d/<id>` (levels,
  autopilot, seed); a settings page; the app icon set. Approved by the
  user on screen; all desktop pages fit one viewport (1024×640 to
  2000×1020), asserted by `scripts/browser-check.ts`.
- The driving stage (`src/dungeons/driving/ui/`): the reference simulator's scene (Model
  Y, town, city, interstate, traffic, pedestrians, signals, sky, shadows),
  chase, driver, and bird's-eye cameras, HUD, minimap, candidate paths
  with probabilities, inspector (decider input, decision state, response,
  perception), crash effects, result cards, the debug sidebar (N), and a
  turn-based / real-time toggle (T). The run plays in a Web Worker and the
  page renders interpolated snapshots.

Validated on the Apple M4 Pro, headless Chromium on Metal at 1440×900,
20 s of town driving with the rule (`scripts/driving-check.ts`,
`scripts/frame-probe.ts`; headless numbers, not a user's screen):

- Frame time, ours with the run on the main thread: 53.6 fps, p95 33.4 ms,
  21 frames over 50 ms. In the worker: 60 fps, p95 16.7 ms, none over
  50 ms, turn-based and real-time. The reference simulator under the same conditions
  (its own nuclis `laya` decider): 58 fps, p95 16.8 ms, one over 50 ms.
- In the browser, turn-based town seed 1 gives 155 decisions, 435 m,
  46 s, no violation, as `bun run eval` does; the stop-line check passes
  at 3.07 m. `bun scripts/driving-reference.ts` on town 1 and the stop
  line is still bit-identical after the stage's refactor.
- `bun test`: 53 pass; `bunx tsc --noEmit`, `bunx biome check` clean.
- Screenshots looked at: `artifacts/driving/` (town chase, candidates,
  driver, bird's-eye, debug, inspector, real-time, finished; city;
  highway on-ramp and interstate; stop line at red and finished) and
  `artifacts/screenshots/r3-*` (gate, lobbies, settings at five sizes).
- With `laya-multilingual` deciding, 22 slow frames and no main-thread
  long task: nuclis shares the GPU on Metal; its `cpu` backend avoids it.

Server logging (2026-10-02): a leveled, colored stdout logger
(`src/server/log.ts`) replaces the server's `console` calls and logs each
API request with its status and time (4xx/5xx at `warn`). `bun test`
58 pass; `bun run lint` clean; checked on a throwaway server (port 7101)
with `GET /api/config`, a 404, and a 400.

nuclis over HTTP (2026-10-02): the nuclis decider calls `nuclis serve`
(`src/deciders/nuclis-http.ts`; the subprocess transport, binary, and
backend settings removed); the settings page's nuclis card takes the API
URL and shows the server's version. Validated on the Apple M4 Pro against
nuclis 0.4.0-dev on Metal (`laya`, `laya-multilingual`):

- `bun test`: 62 pass, among them the decider against a stubbed API
  (answers and debug fields, the models listing, health, `422`, `529`
  retried then answered, `529` to exhaustion, malformed bodies, timeout)
  and `tests/nuclis-live.test.ts` against the real server (skipped when
  `NUCLIS_URL` points nowhere). `bun run lint` clean.
- `bun run eval --dungeon crossing --level distance --decider nuclis
  --model laya-multilingual --seeds 1`: 4 of 12 correct, 3 violations,
  as through the subprocess in milestone 1, at **17 ms** a decision
  (milestone 1: 424–472 ms).
- `scripts/browser-check.ts laya-multilingual` passed on a throwaway
  server (port 7100): Crossing with the rule (12/12) and with
  `laya-multilingual` (4/12) in the browser; an unreachable URL disables
  nuclis in the lobby with "nuclis serve is not running at …". Looked at
  `artifacts/screenshots/config.png` and `lobby-nuclis-down.png`.

The inspector's "Full world" tab (2026-10-02): the reference simulator's
`observation(true)` as `sim/observation.ts`, a read-only view (frame,
ego, navigation, sensor, telemetry, and the world: junctions with their
signals, roads, static objects, traffic controls, vehicles with their
route ids, pedestrians, the planned route, occluded ids), asked of the
worker like perception. It is up to 0.5 MB (highway seed 1, 21k lines),
so it refreshes at 1 Hz, the other tabs at 4. Validated: a test replays
a highway run with the world built before every turn and gets the same
run; `scripts/driving-check.ts town` passed (60 fps with the world open,
p95 16.8 ms, none over 50 ms; looked at
`artifacts/driving/town-inspector-world.png`);
`driving-reference.ts` town 1 and stop-line 42 still bit-identical.

Evaluation mode and the scenario levels (2026-10-02): `RunOptions` on
`Dungeon.create`, the lobby's "Safety nets" switch, `--evaluation` on
`eval`/`check`, `evaluation` in every `RunResult`; the four new scenario
levels in `src/dungeons/driving/scenarios.ts` with the stop line moved
there (*Dungeon 1*, *Decisions*). Validated on the Apple M4 Pro:

- `bun scripts/driving-reference.ts all`: all 13 runs (town, city,
  highway 1–4, stop-line 42) still bit-identical to the reference simulator.
- The rule passes every scenario: `bun run check driving/<level>
  --decider rule` on seeds 1–3 (merge 1–6, off-road 1–4), all pass;
  random fails `stop-sign` on 2 of 4 seeds (entered before the first
  arrival) and `off-road` on 4 of 4, and passes `merge` and
  `blocked-lane` (the safety nets carry it; evaluation mode is what
  separates there).
- Before lifting the taper, evaluation mode offered no colliding in-lane
  path (town and city 1–4); after, town 1 under the rule meets them and
  crashes at 27.9 s (`tests/driving.test.ts` asserts both).
- `bun test`: 75 pass (2 of them against the live nuclis server);
  `bun run lint` clean. `scripts/driving-check.ts` passed on every
  scenario level in the browser (each card PASSED); looked at
  `artifacts/driving/{stop-sign,merge,blocked-lane,off-road}-{running,finished}.png`
  and `artifacts/screenshots/lobby-driving-evaluation.png`.

Not done: the measurement table across deciders (*Pick up here*).
Manual driving and touch controls are a separate, undecided question
(*Decisions*).

### Milestone 4, text dungeons: done (2026-10-02)

Delivered: Inbox, Ticket triage, and Logs (four levels each) on one
builder (`src/dungeons/text/`), seeded generators per dungeon, case sets
in SQLite (`src/server/cases.ts`, `dungeons.db`), `bun run seed`,
`GET /api/cases/:dungeon[/:set?level=]`, the lobby's case-set picker, the
document card view (email, ticket, log window beside answers, known
answers, and why), gate art, `--set` on `eval`/`check`,
`RunResult.caseSet` and `RunResult.truncated` (*Decisions*). Base sets:
inbox 360 cases (hash `547057d4391c013f`), tickets 360
(`82bdfd3b84a23981`), logs 340 (`407ba5af2d34a56a`), all seed 1.

Validated on the Apple M4 Pro:

- `bun test`: 82 pass (generators reproduce their hash and differ by
  seed; every case is a valid request whose known answers fit its
  questions; yes/no levels are balanced 30–70%; the store writes once,
  refuses a different set under a name, replaces on demand, mode 600; the
  API lists and sends sets). `bun run lint` clean.
- `bun run seed` on an empty home: three base sets in 7–17 ms each;
  rerun: unchanged; a new set name adds cases; a different set under an
  existing name is refused.
- The baselines on the base sets, seeds 1–4 (`bun run eval --dungeon
  <id> --decider rule|random --seeds 1-4`), mean accuracy and passes:
  the rule passes Inbox phishing and long (1.00), triage 3/4 (0.91),
  languages 1/4 (0.76, English keywords); Tickets routing 3/4 (0.94),
  urgency 2/4 (0.89), refunds 4/4, languages 0/4 (0.16); Logs thresholds
  4/4 (exact arithmetic), root cause 4/4 (0.99), long 4/4, incident 2/4
  (0.88). Random passes nothing (0.11–0.53, chance for each question).
- A first real run (`laya`, `laya-multilingual`, Inbox seed 1, while the
  driving measurements loaded the server): phishing 0.55 and 0.70, triage
  0.55 and 0.40, languages 0.95 and 0.60, long 0.60 and 0.60 with 20 and
  17 of 20 states truncated.
- `scripts/browser-check.ts none` passed: the gate with five gateways,
  each lobby at five sizes, Inbox phishing, Tickets urgency, and Logs
  thresholds played by the rule in the browser (pass, 95–100%). Looked at
  `artifacts/screenshots/{gate-1440x900,lobby-inbox-1440x900,inbox-rule-running,logs-rule-finished}.png`.

Batched decisions (2026-10-02): text dungeons' cases are independent,
so `Dungeon.observeAll` gives every request of a run at once and
`decideManyWith` sends those with the same questions together, up to 64
states per `/v1/decisions` call (`Decider.decideBatch`, nuclis only);
each answer is validated as one at a time is, `debug.batch` names the
call's size, and `timings.total` is the call's time shared out. `bun run
eval` batches where it can; `--sequential` turns it off; every result now
records `wallMs` and, when batched, `batched`. Measured on the M4 Pro,
`laya-multilingual`, Logs thresholds and incident, seeds 1–3, while three
`laya` driving evals shared the server (so relative, not absolute):
identical answers both ways (same correct counts and Brier scores), wall
time per 20-case run 2.5–4.9 s batched against 11.9–17.4 s one at a time,
about 4.3× faster. `bun test` 85 pass.

### Milestone 5, Night Tower: done (2026-10-02)

Delivered: *Dungeon 2* above; its gate gateway and lobby;
`scripts/tower-check.ts`. Validated on the Apple M4 Pro:

- `bun test`: 92 pass, among them the rule working every level on seeds
  1-2 with no incident, random failing every traffic level with
  incidents, every request valid, the go-around check failing a landing
  clearance over the stopped jet, and a frame-by-frame stage run equal to
  the headless one (outcome and every radio call).
- Headless, seeds 1-3: the rule passes all four levels (rush hour: 22
  flights, about 130 decisions, 0-1 go-arounds, departures held 118-148 s
  on average); random fails every one (1-7 incidents, 4-21 go-arounds). A
  whole rush-hour shift runs in under 100 ms.
- `bun run eval --dungeon tower --level evening,go-around --decider
  nuclis --seeds 1` against nuclis 0.4.0-dev: `laya` handled the quiet
  evening's traffic with 2 incidents; `laya-multilingual` held every
  departure for the whole shift (150 decisions, none released, timed
  out); both cleared the landing over the stopped jet in the go-around
  check.
- `scripts/tower-check.ts evening,go-around` passed in headless Chromium
  on Metal: 60 fps (p95 16.7 ms, none over 50 ms), both shifts passed by
  the rule in the browser. Looked at
  `artifacts/tower/evening-{tower,question,answered,final,overview,end}.png`,
  `go-around-end.png`, and the lobby at five sizes.

### The comparison across deciders

Driving, seeds 1-4 per world, with and without evaluation mode
(`bun run eval --dungeon driving --level <world> --decider <id> --seeds
1-4 [--evaluation]`), on the Apple M4 Pro with nuclis 0.4.0-dev on Metal.
Default runs (evaluation off) at `e27f03e`-`89bae20`, unchanged in
behaviour across them (the reference check stays bit-identical);
evaluation runs at `93a55ac`. ms/decision was measured with up to twelve
evals sharing the nuclis server, so it is contended, not a latency
figure; `laya`'s default runs were rerun alone after its first ones timed
out at their first decision under that load.

| decider | world | evaluation | passed | arrived | collisions | violations | safety brake % (mean) | decisions | ms/decision |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| laya | town | off | 4/4 | 4 | 0 | 0 | 5 | 689 | 676 |
| laya | town | on | 2/4 | 2 | 2 | 0 | 0 | 607 | 1328 |
| laya | city | off | 4/4 | 4 | 0 | 0 | 9 | 660 | 688 |
| laya | city | on | 0/4 | 0 | 4 | 0 | 0 | 280 | 1582 |
| laya | highway | off | 4/4 | 4 | 0 | 0 | 0 | 1389 | 382 |
| laya | highway | on | 4/4 | 4 | 0 | 0 | 0 | 1389 | 688 |
| laya-multilingual | town | off | 4/4 | 4 | 0 | 0 | 4 | 700 | 1528 |
| laya-multilingual | town | on | 2/4 | 2 | 2 | 0 | 0 | 634 | 1291 |
| laya-multilingual | city | off | 3/4 | 3 | 1 | 0 | 7 | 568 | 1729 |
| laya-multilingual | city | on | 0/4 | 0 | 4 | 0 | 0 | 302 | 1539 |
| laya-multilingual | highway | off | 3/4 | 4 | 0 | 1 | 0 | 1490 | 831 |
| laya-multilingual | highway | on | 3/4 | 4 | 0 | 1 | 0 | 1492 | 662 |
| random | town | off | 3/4 | 4 | 0 | 2 | 2 | 748 | 0 |
| random | town | on | 2/4 | 3 | 1 | 1 | 0 | 701 | 0 |
| random | city | off | 3/4 | 4 | 0 | 1 | 6 | 709 | 0 |
| random | city | on | 0/4 | 1 | 3 | 1 | 0 | 499 | 0 |
| random | highway | off | 4/4 | 4 | 0 | 0 | 0 | 1428 | 0 |
| random | highway | on | 4/4 | 4 | 0 | 0 | 0 | 1431 | 0 |
| rule | town | off | 4/4 | 4 | 0 | 0 | 3 | 685 | 0 |
| rule | town | on | 2/4 | 3 | 1 | 1 | 0 | 643 | 0 |
| rule | city | off | 4/4 | 4 | 0 | 0 | 5 | 658 | 0 |
| rule | city | on | 1/4 | 1 | 3 | 0 | 0 | 420 | 0 |
| rule | highway | off | 4/4 | 4 | 0 | 0 | 0 | 1359 | 0 |
| rule | highway | on | 4/4 | 4 | 0 | 0 | 0 | 1359 | 0 |

What it shows: with the safety nets on, every decider arrives nearly
always, random included (10 of 12), as the reference simulator found. Evaluation mode
separates them where traffic is dense: in the city, rule 1/4, random 0/4,
`laya` 0/4, `laya-multilingual` 0/4, all by collisions; the interstate
stays easy for everyone (its traffic is spaced). The rule itself leans on
the planner: it is the experiment's rule, kept as the oracle of the reference comparison.
The text dungeons and Night Tower are measured in their milestones above.

### clef-flash support (2026-10-03)

nuclis now serves `clef-flash` beside Laya and reports in `GET /v1/models`
how each model runs (`nuclis.family`, `packs`, `images`, `max_len`).
Delivered: the nuclis decider reads `packs` (*The decision contract*,
*Decisions*): one state per request and at most two in flight for a
model that does not pack, a timeout from the work (300 s queue plus 8 ms
per estimated token) instead of the fixed 20 s, `bun run eval` batching
only packing models, and an empty `bucket` (clef has none) omitted rather
than shown. Before the change, Inbox `long` on clef timed out at 20 s
with nothing decided, and the aborted 20-state request kept the GPU busy
long enough for a later `laya-multilingual` request to get `529 timeout`.

Validated on the Apple M4 Pro against nuclis 0.4.0-dev on Metal (the
server at nuclis `5dc6783`, reporting `packs`):

- `bun test`: 99 pass, among them a non-packing model sent one state per
  request with never more than two in flight, the timeout per packing
  call and per token, an entry without `packs` listed unavailable and
  refused, and `tests/nuclis-live.test.ts` deciding a Crossing case with
  `clef-flash` (no `bucket`, no `tokensRead`). `bun run lint` clean.
- Measured warm with nuclis's own rate request (two questions, a
  93-character state), curl on loopback: `laya` 35 ms,
  `laya-multilingual` 15 ms, `clef-flash` 0.95 s. Four clef states took
  3.84 s one after another, 3.67 s as one request's `states`, and 3.74 s
  as four concurrent requests: no gain from batching.
- `bun run eval --dungeon crossing --level distance --decider nuclis
  --model clef-flash --seeds 1`: 3 of 12, every case answered stop (the
  threshold weakness Laya also shows), 732 ms a decision.
- `bun run eval --dungeon inbox --level long … --model clef-flash
  --seeds 1`: passed, 20 of 20, none truncated, 4.7 s a decision, 94 s
  for the run, one request per case (nuclis counted 31 requests in 31
  passes over both evals). Laya scored 0.60 there with 17–20 of 20
  states cut (*Milestone 4*).

Not done: the lobby and settings page show clef like any model (no UI
change was needed, none was checked in a browser this session); clef is
not yet in the comparison tables.

### Several questions per case (2026-10-03)

Delivered: an `all-questions` level in Inbox, Ticket triage, and Logs
(*Decisions*), tagged `many-questions`; the long levels tagged
`long-input`; the lobby's tag pills ("Several questions · for
clef-flash", "Long input · for clef-flash"); case sets that grow by new
levels, so the user's and every existing base set gains the level in
place (generators `inbox@2`, `tickets@2`, `logs@2`).

Validated on the Apple M4 Pro:

- `bun test`: 101 pass (a set grows by a level keeping every stored case,
  a changed stored level is still refused; every `all-questions` case has
  a known answer for each question its level asks). `bun run lint` clean.
- The rule, seeds 1-4 (`bun run eval --dungeon <id> --level
  all-questions --decider rule --seeds 1-4`): Inbox 4/4 (0.90-1.00),
  Logs 4/4 (0.90-1.00), Tickets 2/4 (0.80-0.95; its urgency rule).
  The throwaway home's base sets, written before, grew in place.
- `scripts/browser-check.ts none` passed on a throwaway server (no page
  scroll at five sizes with the fifth level). Looked at
  `artifacts/screenshots/lobby-inbox-{1440x900,1024x640}.png` and
  `{tickets,logs}-all-questions-{running,finished}.png` (every question's
  answer and expected value on the case card; no console errors).
- Seed 1, one eval at a time, nuclis 0.4.0-dev on Metal (server at
  nuclis `fd09aa4`), base sets as above:

  | dungeon (questions) | model | result | right | Brier | ms/case | tokens | truncated | wall s |
  | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
  | Inbox (2) | laya-multilingual | fail | 10/20 | 0.165 | 84 | 10,924 | 0 | 1.7 |
  | Inbox (2) | clef-flash | pass | 18/20 | 0.035 | 1,896 | 10,020 | 0 | 37.9 |
  | Tickets (3) | laya-multilingual | fail | 5/20 | 0.356 | 88 | 13,127 | 0 | 1.8 |
  | Tickets (3) | clef-flash | fail | 17/20 | 0.056 | 2,334 | 11,929 | 0 | 46.7 |
  | Logs (2) | laya-multilingual | fail | 4/20 | 0.339 | 404 | 32,932 | 2 | 8.1 |
  | Logs (2) | clef-flash | pass | 18/20 | 0.005 | 4,089 | 21,526 | 0 | 81.8 |

  clef-flash is right on 53 of 60 cases at all of its questions at once,
  laya-multilingual on 19, at 20-45 times the time per case (single
  runs, not a benchmark).

### Milestone 6, vision: in progress (2026-10-03)

Delivered: images in the contract and the deciders (*The decision
contract*), pictured cases rendered from their seeded source into the case
set (*Decisions*), and Receipts: five levels (policy as text, from the
picture, picture and text, read the total, everything on the slip), its
rule (the policy applied to the data), the slip in the play view with
what the autopilot was given, the gate's gateway, and the lobby's picture
tags and filtering. `playwright-core` became a dev dependency for the
renderer.

Validated on the Apple M4 Pro:

- `bun test`: 106 pass (images within bounds, nuclis sending them and
  batching only equal ones, TypeSafe refusing them; the three policy
  levels asking the same receipts with the picture only where shown; the
  total question offering the case's own four totals; the rule exact on
  the data and `rejected` on a picture; the store rendering on first use
  through a fake renderer). `bun run lint` clean.
- The base set (`receipts@1`, 140 cases, hash `e351cc3291c927df`)
  rendered and stored in about 9 s on first use, about 32 KB a slip at
  340 px wide; the policy levels approve 27 of 60, and every total
  question's four options hold the truth.
- `bun run eval --dungeon receipts --level policy-text --decider rule
  --seeds 1-4`: 20 of 20 on every seed.
- Seed 1, one eval at a time, nuclis 0.4.0-dev on Metal (server at nuclis
  `fd09aa4`):

  | level | model | result | right | Brier | ms/case | tokens | wall s |
  | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
  | policy-text | laya-multilingual | fail | 6/20 | 0.543 | 53 | 6,633 | 1.1 |
  | policy-image | laya-multilingual | `rejected` | — | — | — | — | — |
  | policy-text | clef-flash | fail | 17/20 | 0.097 | 1,553 | 8,024 | 31.1 |
  | policy-image | clef-flash | fail | 16/20 | 0.130 | 2,250 | 8,051 | 45.0 |
  | policy-both | clef-flash | pass | 18/20 | 0.078 | 2,809 | 10,955 | 56.2 |
  | total | clef-flash | pass | 20/20 | — | 2,004 | 6,616 | 40.1 |
  | all-questions | clef-flash | fail | 16/20 | 0.144 | 3,421 | 14,219 | 68.4 |

  On the same receipts clef-flash is right on 17 from the data, 16 from
  the picture alone, and 18 with both; it read every total right from
  the picture. Laya cannot see pictures (`images_unsupported`, a typed
  rejection), and on the data it is near chance. Single runs, not a
  benchmark.
- `scripts/browser-check.ts none` passed on a throwaway server after the
  settings fix (no page scroll at five sizes; the defaults list scrolls
  inside its card at 1024x640 and 1280x720). Looked at
  `artifacts/screenshots/{gate-receipts,lobby-receipts,lobby-receipts-image,receipts-rule-running,receipts-clef-image,receipts-clef-both,config-1280x720}.png`:
  choosing a picture level switched the autopilot to clef-flash and
  disabled Laya, the rule, and TypeSafe; clef-flash played the picture
  levels in the browser with no console errors.

Not done: the receipts' line prices are random splits of the subtotal
(a lemonade can cost more than a curry), harmless to the policy but not
realistic; the other vision dungeons of *Milestones*.

### The Laya→clef cascade (2026-10-03)

Delivered: the Cascade decider (*Decisions*): screened in one batch call
where the dungeon batches, the unsure states judged one at a time;
`RunResult.escalated`, the `escalated` column and `--threshold` sweeps in
`bun run eval`; the route in the debug sidebar ("laya-multilingual 59%
(needs 85%) → clef-flash, unsure"); the lobby's Cascade row.

Validated on the Apple M4 Pro:

- `bun test`: 111 pass (`tests/cascade.test.ts`: the id, the pairs from
  the listing, a sure screen kept, unsure, cut, and pictured states
  judged, a batch screened in one call and judged one at a time, the run's
  escalated count; a cascade saved as a lobby default). `bun run lint`
  clean.
- In the browser (throwaway server, port 7100): the lobby lists the pairs;
  an Inbox run with `laya-multilingual → clef-flash` played with the route
  in the sidebar and no console errors. Looked at
  `artifacts/screenshots/{lobby-inbox-cascade,inbox-cascade-debug}.png`.
- Seed 1, `laya-multilingual:clef-flash`, one eval at a time (nuclis
  0.4.0-dev on Metal, server at nuclis `fd09aa4`), cases right and wall
  time beside each model alone (*Several questions per case*,
  *Milestone 6*):

  | level | Laya alone | clef alone | cascade 0.75 | cascade 0.85 | cascade 0.95 |
  | --- | --- | --- | --- | --- | --- |
  | Inbox all-questions | 10, 1.7 s | 18, 37.9 s | 17, 25.8 s (13 judged) | 17, 27.9 s (14) | 18, 39.5 s (20) |
  | Tickets all-questions | 5, 1.8 s | 17, 46.7 s | 16, 45.6 s (19) | 17, 48.0 s (20) | 17, 53.2 s (20) |
  | Logs all-questions | 4, 8.1 s | 18, 81.8 s | 14, 74.4 s (13) | 18, 96.3 s (20) | 18, 100.9 s (20) |
  | Receipts policy-text | 6, 1.1 s | 17, 31.1 s | 7, 10.5 s (5) | 9, 17.4 s (9) | 16, 33.8 s (18) |

  What it shows: laya-multilingual's confidence picks out its mistakes
  only on Inbox, where the cascade keeps 17 of clef's 18 at two thirds of
  the time. With three questions (Tickets) it is almost never sure of
  all, so nearly everything goes to clef; on Logs and Receipts it is
  confidently wrong (Receipts at 0.75 keeps 15 and gets 7 right), so a
  low threshold costs accuracy. Single runs, one seed, not a benchmark.

### Milestone 7, The Oracle: done (2026-10-03, commit `ff61c37`)

Delivered: *Dungeon 3* as above: `oracle@1` (120 `numbers` days, 80
`many` days in a base set, hash `34c1d7a1192269c3`), five levels, the
truth gap, Brier beside the oracle's, skill, log loss, and calibration
bins (`Outcome.calibration`, pooled by `bun run eval`), the fitted
wind-and-swell rule, the play view (the day as the autopilot read it, a
track per question with the autopilot's chance against the true one, a
live reliability diagram built to the `dataviz` skill, the truth gap so
far), its gateway and lobby. `TextCase.odds` and schema 3 in the case
store; the text builder's `score` and `record` hooks.

Validated on the Apple M4 Pro (macOS 27), Bun 1.4.2:

- `bun test` (with `NUCLIS_URL` at a closed port, so the 3 live tests
  skip while clef-flash held the GPU): every test passes, among them
  `tests/oracle.test.ts`: outcomes drawn at the true rates (3,000 days,
  within 0.03 per question), a case unmoved by writing more, the four
  presentations playing the same days, odds kept by the store, a
  forecaster who answers the true chances scoring a gap of 0 and the
  oracle's Brier, the rule reading every presentation alike.
- In the browser (throwaway server, port 7100): the rule on `numbers`
  and `contradiction`, laya-multilingual on `scattered` and `many`; no
  console errors, no page scroll at 1440×900. Looked at
  `artifacts/oracle/{lobby,numbers-rule-finished,scattered-laya-ml-running,many-laya-ml-finished}.png`
  and `artifacts/screenshots/{oracle-rule-running,lobby-oracle-1024x640}.png`.
- Measured at `ff61c37`, seeds 1–4, base set `34c1d7a1192269c3`, nuclis
  0.4.0-dev on Metal, one eval at a time (`bun run eval --dungeon oracle
  --decider <id> [--model <m>] --seeds 1-4`; the cascade is
  `laya-multilingual:clef-flash@0.85`). Mean truth gap over the four runs
  of each level (lower is better; the rule's equal rows are the same days
  read from four presentations):

  | decider | numbers | log | scattered | contradiction | many |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | rule (wind and swell) | 0.106 | 0.106 | 0.106 | 0.106 | 0.149 |
  | clef-flash | 0.194 | 0.177 | 0.197 | 0.400 | 0.157 |
  | laya | 0.275 | 0.271 | 0.285 | 0.266 | 0.335 |
  | laya-multilingual | 0.395 | 0.331 | 0.255 | 0.275 | 0.475 |
  | cascade | 0.395 | 0.324 | 0.222 | 0.412 | 0.219 |
  | random | 0.274 | 0.365 | 0.363 | 0.363 | 0.329 |

  Brier against the oracle's (0.204 on the shared days, 0.180 on `many`):
  clef-flash 0.285–0.425, laya 0.242–0.295, laya-multilingual
  0.271–0.456. Time per decision: laya 110–400 ms, laya-multilingual
  63–186 ms, clef-flash 1.6–3.7 s; the cascade judged 0 of 80 days on
  `numbers`, 8 on `log`, 61 on `scattered`, 52 on `contradiction`, 66 on
  `many`.

  What it shows: no model beats a two-number logistic. laya-multilingual
  says she sails at about 97% on nearly every `numbers` day (the pooled
  calibration: 80 of 80 forecasts in the top bin, 60% came true), and it
  is surest exactly where it is wrong, so the cascade never escalates
  there: the measured reason the cascade failed before. laya stays near
  even odds (a constant forecaster's gap is about 0.29). clef-flash reads
  the facts best, but on `contradiction` it believes the captain over the
  instruments the handbook says to trust (54 of 80 forecasts under 20%
  where the true chance averaged 52%), its worst level by far. Single
  runs per seed, not a benchmark.

### Milestone 8, Undercroft: done (2026-10-03, commits `520c6e5`, `f38a10a`)

Delivered: *Dungeon 4* as above: seeded maps and the breadth-first
optimum (`map.ts`), six levels, the planner as the rule, the tile
pictures through `src/lib/png.ts` and `Dungeon.render`, the play view (the
map from the same tiles at a larger scale, the trail, fog dimmed, the last
decision's probabilities as arrows, hit points, keys, moves against the
optimum and the pass bound), its gateway and lobby (the picture-only level
disables the rule and Laya). Each request says what the last move did
(`last_move`), added after the first measurement: without it a decider
that bumped once saw the same state until the turn limit.

Validated on the Apple M4 Pro, Bun 1.4.2:

- `bun test`: 136 pass (3 of them live against nuclis), among them
  `tests/undercroft.test.ts`: CRC-32 against the standard check value and
  `Bun.hash.crc32`, a map picture decoded back (chunks, CRCs, zlib, rows)
  to the pixels it was drawn from, the keys map of seed 1 pinned by hash,
  every level's map with a safe way out, keys needed in order, monsters
  lengthening the optimum on six seeds, the rule at the optimum on every
  known map, random failing with bumps, the picture only where shown,
  `observe` refusing a stale picture, `last_move`, fog.
- In the browser (port 7100): the rule on `keys` (42 moves, the optimum),
  `fog`, and `corridors`; clef-flash on `picture` for four turns (the
  debug sidebar shows each move's probability, 2.1–2.2 s a move), then
  paused and left, nuclis's queue idle after. Looked at
  `artifacts/undercroft/{keys-rule-running,keys-rule-finished,fog-rule-running,picture-clef-running}.png`
  and `artifacts/screenshots/{lobby-undercroft-picture,lobby-undercroft-1024x640,undercroft-rule-finished}.png`.
- Measured, seeds 1–4, nuclis 0.4.0-dev on Metal, one eval at a time:
  the rule and random at `f5a7999` (random before `last_move`, so its
  answers, hashed from the request, would differ now; the rule reads only
  the map), laya-multilingual at `9415664` (before `last_move`) and again
  with laya at `6dc909e`, clef-flash and the cascade
  (`laya-multilingual:clef-flash@0.85`) at `d044b11` (with `last_move`).
  Passed runs of 4 per level, moves against the optimum per seed, bumps
  summed over the four runs:

  | decider | corridors | keys | monsters | fog | picture | picture-both |
  | --- | --- | --- | --- | --- | --- | --- |
  | rule | 4/4, at the optimum | 4/4, at the optimum | 4/4, at the optimum | 4/4, efficiency 0.59–1 | `rejected` (no map in text) | 4/4, at the optimum |
  | random | 0/4, 168 bumps | 0/4, 316 | 0/4, 221, one death | 0/4, 200 | 0/4, 319 | 0/4, 339 |
  | laya | 0/4, 0 moves, 330 bumps | 0/4, 0 moves, 600 | 0/4, 0 moves, 504 | 0/4, 12 moves, 378 | — | — |
  | laya-multilingual | 0/4, 56 moves on seed 1, 274 | 0/4, 84 moves on seed 1, 516 | 0/4, 0 moves, 504 | 0/4, 0 moves, 390 | — | — |
  | clef-flash | 0/4 (78/26 6/32 0/28 2/24), 244 | 0/4 (4/42 0/62 0/56 84/40), 512 | 0/4 (2/40 0/52 132/44 2/32), 368 | 0/4 (0–2 moves), 386 | 0/4 (0–3 moves), 595 | 0/4 (2/42 0/62 0/56 80/40), 518 |
  | cascade | as clef-flash, move for move | | | | | |

  Time per move: laya-multilingual about 53 ms, laya 120–140 ms,
  clef-flash 1.8 s on text and 2.3–2.8 s with the picture (a run to the
  turn limit took 5–8 minutes).

  What it shows: no model reaches the stairs on any map, with the map as
  text, as a picture, or both. Laya answers `north` (the first option) on
  nearly every turn; before `last_move` laya-multilingual did on every one
  of 1,818 turns. clef-flash moves a few tiles and then pushes into the
  same wall (on `corridors` seed 2 it went east toward stairs two tiles
  away through a wall, 90 bumps), or paces between two tiles (78 moves on
  `corridors` seed 1, never farther). laya-multilingual never reached the
  cascade's 0.85 on a four-way move, so the cascade sent all 3,016 moves to
  clef-flash and played its game exactly. Seeing the map adds nothing
  measurable here. Single runs per seed, not a benchmark.

### Evensong: done (2026-10-03, commits `f5a7999`, `d044b11`)

Delivered: *Dungeon 5*: the music (`music.ts`: keys and spelling, the
chords a note can take, the rules as faults, the dynamic-programming
organist, seeded tunes), four levels, the two-stave view with the
organist's probabilities and the Web Audio organ, gateway and lobby. A
V7 whose seventh cannot fall was first counted twice (on the V7 and again
on the next chord); it now counts once (`d044b11`), and the written rules
allow a held chord, as the judge does (`9258712`).

Validated on the Apple M4 Pro, Bun 1.4.2:

- `bun test`: `tests/evensong.test.ts`: notes spelled and read back in
  every key, each kind of fault caught (consecutive fifths, a dominant
  falling back, the doubled leading tone, a missing cadence), the organ's
  voicing in chord tones from melody down to bass, the rule flawless on
  every level for seeds 1–4 (and 32 of 32 tunes on seeds 1–8 in `bun run
  eval`), random faulting every chorale, `by-heart` asking the same tunes
  without the rules.
- In the browser (port 7100): the rule on `hymn` and `chorale` (passed,
  the hymn played on the organ on a click with no console errors);
  clef-flash on `phrase` (failed: V7 under the first note, its seventh not
  falling). Looked at
  `artifacts/evensong/{lobby,hymn-rule-finished,chorale-rule-finished,phrase-clef-finished}.png`,
  `artifacts/screenshots/{evensong-rule-finished,lobby-evensong-1280x720}.png`.
- Measured at `6dc909e`, seeds 1–4, nuclis 0.4.0-dev on Metal, one eval
  at a time (`bun run eval --dungeon evensong --decider <id> --seeds
  1-4`). Passed runs of 4, then faults per run:

  | decider | phrase (4 notes) | hymn (8) | chorale (12) | by heart (8) | time per chord |
  | --- | --- | --- | --- | --- | ---: |
  | rule | 4/4, 0 | 4/4, 0 | 4/4, 0 | 4/4, 0 | 0 |
  | clef-flash | 2/4, 2 0 2 0 | 0/4, 1 4 4 5 | 0/4, 4 5 3 3 | 0/4, 1 1 1 3 | 2.1–3.1 s |
  | cascade | 2/4, 2 0 2 0 | 0/4, 1 4 4 5 | 0/4, 4 5 3 3 | 0/4, 1 1 1 4 | 2.1–3.2 s |
  | laya | 0/4, 3 1 3 3 | 0/4, 2 6 3 2 | 0/4, 7 5 6 6 | 0/4, 2 6 3 2 | 110–145 ms |
  | laya-multilingual | 0/4, 2 2 2 3 | 0/4, 5 6 5 5 | 0/4, 5 8 4 5 | 0/4, 7 5 5 5 | 59–72 ms |
  | random | 0/4, 1 1 2 3 | 0/4, 6 6 6 5 | 0/4, 8 6 9 4 | 0/4, 5 4 3 4 | 0 |

  What it shows: only clef-flash ever plays a phrase cleanly, and it plays
  better by heart (26 of 32 chords clean) than with the rules written out
  (18 of 32 on the same hymns): stated rules made it worse, chiefly with
  consecutive fifths and octaves (9 with the rules, 0 by heart). Its
  commonest fault either way is a phrase not ending on V. laya's choices
  are identical with and without the rules, answer for answer. The
  cascade almost always escalated, so it plays as clef-flash. Single runs
  per seed, not a benchmark.

### Pick up here

Milestones 1–5, 7, and 8 are done, with Evensong beside them; clef-flash
is supported, every text dungeon asks all its questions at once on one
level, the Laya→clef cascade is a decider, and milestone 6 has its first
dungeon (Receipts). What is left, in order:

1. **Questions for the user** (each changes what a decider sees, so it is
   theirs to decide):
   - Undercroft gives the decider no memory beyond `last_move`: clef-flash
     paces between two tiles. Should the request carry the recent moves or
     the trail (marked on the text map and the picture)?
   - The Oracle's pass bound (0.10) is passed by no model yet; keep it as
     the bar, or relax it?
   - Evensong's `by-heart` level judges rules it does not state (the half
     cadence above all); keep that as the point of the level?
2. **Milestone 6, the next vision dungeons** (*Milestones*): driving
   frames with a blind-state level, dashboards beside logs, interface
   screenshots, rendered inbox mail. Receipts' line prices could be made
   realistic first.
3. **Wider measurements**: clef-flash and the cascade in the comparison
   tables (driving turn-based, text dungeons, Night Tower, Receipts) over
   seeds 1–4, one eval at a time since clef holds the GPU; the cascade
   with `laya` (English) as the screener too; TypeSafe Jev when the user
   approves a paid run. The Oracle can measure any new model's
   calibration directly.
4. **Night Tower, if the user wants more of it**: a ground radar view,
   arrivals' speed control, a second runway.
