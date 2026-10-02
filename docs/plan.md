# Decision Dungeons — plan

A local playground for decision models. Each **dungeon** is a world that
asks a decider typed questions about what it sees; the player picks the
dungeon, its level, and the **autopilot** (which decider, which model), then
watches it play, with a debug sidebar showing what the decider read and
answered. The same dungeons run headless and produce comparison tables.

Status (2026-10-02): milestones 1 (the skeleton) and 2 (driving,
headless, proven bit-identical against JevPilot) are done. Milestone 3
(driving UI) is **in progress**: the scene, HUD, gate, and lobbies are
done; the inspector's world tab, evaluation mode, and four scenario
levels remain (*Progress* → *Pick up here*). A new session starts at
*Start here* below.

## Start here

1. Read this plan, then `AGENTS.md`.
2. Read the references below, in that order, before writing code.
3. Read *Progress* at the end of this file, then *Working notes* below,
   and continue from **Pick up here**. Record what each session delivered
   in *Progress*.

**What exists and what does not, today.** `nuclis` is installed on the
`PATH` (`nuclis --version`) with `laya` and `laya-multilingual` pulled, so
the nuclis decider's `spawn` transport makes real decisions now; the rule
and random deciders need nothing. `nuclis serve` does not exist yet:
build no `serve` transport and no mock of it, since its API is not
settled; it arrives with its reference document (*References*). Tests use
a fake `nuclis` executable (a short script that prints canned `--json`
output, as JevPilot's `tests/nuclis.test.js` does) and never need a model,
a GPU, a key, or the network. The TypeSafe decider is tested against a
stubbed `fetch`; a real Jev call needs `TYPESAFE_API_KEY` and is an
explicit command, never a default test.

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
- **Check it.** `bun test` (58 tests, no network or model), `bun run lint`
  (`tsc --noEmit` and `biome check`), `bun run eval …` and
  `bun run check driving/stop-line --decider rule` (*Headless runs*).
- **The driving simulation is proven bit-identical to JevPilot.** After
  any change under `src/dungeons/driving/{world,sim,decide}` or
  `driving.ts`, run `bun scripts/driving-reference.ts all` (about 15 min;
  `town 1` and `stop-line 42` take 20 s) and keep every run
  `"identical": true`. Floating-point operation order matters: reorder
  no sum, and draw from the seeded generators in the same order. It reads
  JevPilot from `~/Code/jevpilot` (`JEVPILOT` overrides).
- **Browser checks.** Playwright is not a dependency. Install it once in
  a scratch directory and point `NODE_PATH` at it:
  `mkdir -p /tmp/dd-pw && (cd /tmp/dd-pw && bun add --exact playwright-core@1.63.0)`,
  then `NODE_PATH=/tmp/dd-pw/node_modules BASE_URL=http://127.0.0.1:7100 bun scripts/browser-check.ts none`
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

## How this started: the JevPilot experiment

On 2026-10-02 nuclis's Laya decision model was tested as a drop-in for
TypeSafe's hosted Jev in JevPilot, Standard Agents' driving simulator, by
running `nuclis decide` as a subprocess. What it showed, which this
project builds on:

- **Jev's request shape is the interface.** `nuclis decide --request -
  --json` reads Jev's request (`state`, `questions`) and writes Jev's
  answers, so swapping deciders is one function.
- **Short-budget models need the request rewritten.** Laya reads 512
  tokens (`laya-multilingual` 1,024); JevPilot's state was 700–850 tokens
  with the candidate table last, so Laya never saw the options. Moving each
  candidate's facts into its option text, situational instructions first
  and road geometry last, fixed it and cost Jev nothing (Jev stopped within
  0.13 m of its own result on the rewritten request).
- **Outcomes hide decisions.** JevPilot's candidate filter, speed taper,
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
  image dungeons of milestone 5.

## References

- **JevPilot**, `~/Code/jevpilot`, branch `nuclis-decider` (commit
  `4cca4fc`, on top of upstream `e1beeb1`). The source of the driving
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
- **nuclis**, `~/Code/nuclis`, used only as a black box (CLI or HTTP):
  - `nuclis decide --help`, `nuclis model ls --json` (decision entries
    have `kind: "decision"`).
  - `docs/reference/laya.md`: the input contract, budgets, calibration,
    `--json` and `--explain` fields, timings.
  - `TODO.md` § APPS-19: the design of the coming `nuclis serve`, the
    local nuclis HTTP API (decisions first, OpenAI-compatible chat
    later). **For orientation only**: its routes and fields
    may change while nuclis builds it. When it lands, nuclis writes its
    API reference (`docs/reference/api.md` in nuclis), and that
    document, handed over then, is what the `serve` transport is built
    against. Until then, nothing here calls or mocks it.
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
- First dungeon: autopilot driving, keeping JevPilot's look and feel,
  rewritten rather than copied.

Non-goals (for now): hosting, accounts, payments, play credit, mobile-first
work beyond what the driving UI already does, training models.

## Stack

- **Bun 1.4** (1.4.2 installed): `bun install`, `bun test`, `Bun.serve`
  with HTML imports for the dev server and its hot reload, `bun build` for
  production, `Bun.spawn` for `nuclis decide`. No npm, no Vite.
- **TypeScript, strict**, run directly by Bun. The decision contract, the
  dungeon interface, and the driving state get real types; JevPilot's
  implicit shapes (state, candidates, answers) were its main source of
  validation code.
- **three.js** (0.183.2, as JevPilot) for the driving dungeon; Phosphor
  and game-icons.net icons on the gate, lobbies, and settings, lucide in
  the play views; Fraunces and DM Sans, bundled (*Decisions*).
- **Biome** for formatting and linting (one binary, TypeScript-native, no
  plugin stack), `tsc --noEmit` for types, `bun test` for tests.

## The decision contract

The request and response are Jev's shape, which `nuclis decide` already
reads and writes. That is the interface every decider speaks:

- `Request`: `{ state, questions: { [id]: { type, instructions, criteria } } }`,
  `type` one of `choice`, `score`, `noul`.
- `Request` may carry images once nuclis accepts them (MODL-34 session 4
  defines the field); until then dungeons send text and JSON only.
- `Answer`: Jev's fields (`choice`/`probabilities`/`confidence`, `score`,
  `noul`) plus an optional `debug` object (logits, temperature, tokens
  read, state kept) that only the debug sidebar reads.
- `Decision`: `{ answers, usage, timings, debug }`.

```ts
interface Decider {
  id: string;                      // "nuclis", "typesafe", "rule", "random"
  label: string;
  models(): Promise<ModelInfo[]>;  // nuclis: from `nuclis model ls --json`
  status(): Promise<DeciderStatus>;// configured, reachable, version, pricing
  prepare?(req: Request, model: string): Request; // budget-aware rewrite
  decide(req: Request, opts: { model: string; signal: AbortSignal; seed?: number }): Promise<Decision>;
}
```

Every caller goes through `decideWith` (`src/contract/decider.ts`), which
prepares, times, and validates: no path trusts a decider's answers.

- **nuclis**: one decider over a transport. `spawn` runs `nuclis decide
  --request - --json --explain --model <m>` and lists models with
  `nuclis model ls --json`; it is the only transport built now. A second,
  `serve`, will call `nuclis serve` over HTTP once nuclis has built it and
  provided its API reference (see *References*); keep the transport a
  small interface (`decide`, `models`) so `serve` slots in beside `spawn`
  without touching the decider. Models are the decision entries nuclis
  lists (`kind: "decision"`; today `laya`, `laya-multilingual`), so a new
  nuclis decision model shows up in the picker by itself. The rewrite
  proven in JevPilot (each option carries its own facts, situational
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
    deciders/      nuclis.ts, nuclis-spawn.ts, typesafe.ts, random.ts, registry.ts
    lib/           seeded randomness (JevPilot's mulberry32, exactly)
    server/        Bun.serve: app.ts (API), config.ts, assets.ts (models,
                   textures, draco, the driving worker), icons.ts, main.ts
    dungeons/
      dungeon.ts   the Dungeon interface; turn.ts one turn; run.ts a whole
                   headless run and its RunResult; registry.ts
      crossing/    the stop-line quiz: crossing.ts, view.ts (card view)
      driving/
        world/     geometry, grid (town, city), highway, road, reroute
        sim/       simulation, vehicle, traffic, collisions, courtesy,
                   rules, navigation, perception, plan (candidates)
        decide/    state, request, selection, rule
        driving.ts the dungeon: levels (worlds and checks), turns, outcome
        ui/        stage.ts (the full-screen view), sim.worker.ts,
                   playback.ts, protocol.ts, scene/ (three.js), minimap,
                   inspector, driving.css
    ui/            gate, lobby, settings (config-page), play (card view and
                   stage hook), debug sidebar, autopilot picker, sky, icons,
                   topbar, dungeon-art, store, api, style.css
    cli/           eval.ts: `bun run eval` and `bun run check`
  tests/           contract, deciders (fake nuclis), server, crossing,
                   driving, driving-ui
  scripts/         browser-check, driving-check, frame-probe,
                   driving-reference (vs JevPilot), render-icons
  public/          models, textures, draco, icons, with licenses
  NOTICE.md
```

The dungeon interface keeps the simulation headless and deterministic:

```ts
interface Dungeon<Run> {
  id: string; title: string; levels: Level[];
  create(seed: number, level: string): Run;
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
  the nuclis settings (binary path and backend for `spawn`; a URL for
  `serve` once that transport exists), the TypeSafe key. Stored in
  `~/.decision-dungeons/config.json` (mode 600); the key is write-only from the
  browser: reads return only whether it is set. Environment variables
  (`TYPESAFE_API_KEY`, `NUCLIS_BIN`) override the file.
- `POST /api/decide`: `{ dungeon, decider, model, request }` →
  `Decision`. Bounded body size, a timeout per decider, at most three in
  flight, errors typed (`unconfigured`, `rejected`, `unavailable`,
  `timeout`, `invalid_answer`) as `{ error: { code, message } }`.
- Bound to `127.0.0.1` (port 7000, `DECISION_DUNGEONS_PORT`). Every API
  route requires a loopback `Host` header; writes must be same-origin
  `application/json`, because the config names a binary the server runs.

## The gate, the lobbies, and the debug sidebar

- The gate (`/`) shows every registered dungeon as a gateway; a dungeon
  without art in `src/ui/dungeon-art.ts` gets a generic one. Its lobby
  (`/d/<id>`): pick a level, an autopilot (decider and model, the
  unconfigured ones shown disabled with the reason), a seed; play. A
  dungeon either plays in the shared card view (Crossing) or supplies a
  full-screen stage (driving; `src/ui/views.ts`).
- The HUD names the active autopilot ("nuclis · laya-multilingual engaged").
- Debug sidebar (N): the generalized version of the one built in JevPilot:
  time split (model load, tokenize, encode, process, HTTP), tokens and
  truncation, one card per question with each option's text,
  probabilities, logits, the pick, and the recent decisions. Fields a
  decider does not report are omitted, not faked.

## Dungeon 1: autopilot driving

Kept from JevPilot: the look of the HUD, minimap, cameras, candidate paths
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
- **An evaluation mode** that turns the safety brake and the candidate
  filter's collision exclusion off, because JevPilot showed they make any
  decider arrive (random arrived on 12 of 12 trips).
- Scenario checks are first-class levels of the driving dungeon
  (`driving.ts`, like `stop-line`): the red-light stop line first, then a
  stop sign with an earlier arrival, a merge gap, a blocked lane, and
  off-road recovery, each with a pass bound and run by every decider.

**Proving the port.** The rule decider is deterministic, so it is the
oracle: for seeds 1–4 in each world and for the stop-line check, the port
and JevPilot (`e1beeb1` plus the `nuclis-decider` branch) must arrive
alike, with the same violations and stop distances within 0.1 m.
Differences are explained or fixed before the UI work. Done: every run
is bit-identical (*Progress*, milestone 2); `scripts/driving-reference.ts`
keeps it so.

## Headless runs

```sh
bun run eval --dungeon driving --decider nuclis --model laya-multilingual --seeds 1-4
bun run check driving/stop-line --decider rule
```

JSON lines per run and a markdown table, the same results types the UI
shows.

## Provenance

`NOTICE.md` records that the driving dungeon is a rewrite of Standard
Agents' JevPilot (commit `e1beeb1`), used with permission, and lists the
assets and their licenses: the Tesla Model Y by 763468712 (CC BY 4.0,
attribution required), Poly Haven models, textures and sky (CC0), the
three.js Ferrari (MIT). Asset license files travel with the assets.

## Milestones

1. **Skeleton.** Bun server, contract, the four deciders, config store and
   page, start screen, debug sidebar, `bun test` for the contract and
   deciders (a fake `nuclis` binary as in JevPilot's tests).
2. **Driving, headless.** World, sim, decision state, rule baseline,
   checks, `eval`; matched against JevPilot as above.
3. **Driving, UI.** The scene and HUD at JevPilot's look, the inspector,
   evaluation mode, scenario levels.
4. **Text dungeons.** Inbox, ticket triage, logs: seeded synthetic cases
   with known answers, scored per decision, levels for long inputs,
   numbers against thresholds, and other languages.
- **When `nuclis serve` lands** (between milestones, whenever nuclis
  provides the API reference): the `serve` transport built against that
  document, models from its listing, and the decision rate it allows (no
  process start or model load per decision, concurrent requests batched)
  measured against `spawn` on the same seeds.
5. **Vision**, once nuclis serves clef-flash with images (MODL-34
   session 4). Images are rendered from seeds (the three.js scene, or
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

## Decisions

- Named **Decision Dungeons**: the repository `~/Code/decision-dungeons`, the
  config directory `~/.decision-dungeons` (2026-10-02).
- `~/Code/decision-dungeons`, local only: no remote, nothing pushed (2026-10-02).
- Bun 1.4, TypeScript strict, Biome (2026-10-02).
- nuclis grows `nuclis serve` (APPS-19, next in nuclis's `TODO.md`); until
  it lands and nuclis provides its API reference, the nuclis decider uses
  `spawn` only, and the `serve` transport is not built or mocked
  (2026-10-02).
- clef-flash arrives through nuclis (MODL-34, after APPS-19), text first,
  images later; Decision Dungeons adds the turn-based mode for it and plans the
  vision dungeons as milestone 5 (2026-10-02).
- Dependencies: lucide 0.577.0 (icons in the play and driving views, as
  JevPilot; the other pages use the icons below); dev only TypeScript
  7.0.2, Biome 2.5.15, @types/bun 1.4.2. Playwright is not a dependency:
  `scripts/browser-check.ts` finds `playwright-core` 1.63.0 through
  `NODE_PATH` (its header has the commands) (2026-10-02).
- **Crossing**, a small text dungeon, ships with milestone 1 so the
  skeleton plays end to end before driving: drive or stop at a signalled
  line, a known answer per seeded case, levels for the signal, the
  distance, and both (2026-10-02).
- The short-budget rewrite is split. Dungeons put each option's facts in
  its text and situational instructions first in the one request every
  decider receives (JevPilot showed this costs Jev nothing, and comparisons
  stay on the same input); nuclis's `prepare` does only the
  dungeon-agnostic part, moving top-level state fields over 400 characters
  to the end, smallest first (2026-10-02).
- The driving stage defaults to turn-based play rather than real time:
  a browser run is then exactly the headless run of the same seed, and a
  slow decider plays the same game (2026-10-02).
- Manual driving (WASD, J, Space) and JevPilot's touch controls are not
  in the plan's milestones; whether to port them is the user's call, not
  yet made (2026-10-02).
- A fifth decide error, `unavailable` (cannot reach the decider, HTTP 5xx,
  cancelled), beside `unconfigured`, `rejected`, `timeout`, and
  `invalid_answer` (2026-10-02).
- The server listens on `127.0.0.1:7000` (`DECISION_DUNGEONS_PORT`); API
  routes require a loopback `Host` (DNS rebinding) and same-origin JSON
  writes (cross-site requests), since the config page can set the binary
  the server runs (2026-10-02).
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

- The driving scene uses three, pinned at 0.183.2 as in JevPilot, with
  `@types/three` 0.183.1 (dev). JevPilot's Model Y (CC BY 4.0), Poly Haven
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
  unreported fields omitted. `NOTICE.md` records the JevPilot origin and
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
  1.0 m threshold, where JevPilot's stop-line check separated them; the
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
  (six 50 ms steps per decision, JevPilot's headless cadence).
- The request is Jev's (candidate, road, and traffic tables) with each
  path's facts also in its option text and situational instructions
  first (*Decisions*); the rule is the JevPilot experiment's fixed rule
  (`/tmp/deciders.mjs` then), read off the request.
- `bun run eval` and `bun run check` (`src/cli/eval.ts`) over
  `runEpisode` (`src/dungeons/run.ts`): a JSON line per run and a
  markdown table of the same `RunResult` objects.
- `scripts/driving-reference.ts`: JevPilot's simulation and the port side
  by side with the same rule, compared at every decision.

Validated on the Apple M4 Pro, Bun 1.4.2, against JevPilot `4cca4fc`:

- `bun scripts/driving-reference.ts all`: seeds 1–4 in town, city, and
  highway and the stop-line check (seed 42) are **bit-identical**: every
  decision's position, heading, speed, steering, and target equal with
  `Object.is`, the same decision counts (town 155, 209, 136, 185; city
  235, 139, 131, 153; highway 338, 340, 340, 341; stop line 28), all
  arriving with no collision and no violation, the stop line at 3.07 m
  (bumper 0.70 m, as JevPilot's README measured for this rule) and
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
- The driving stage (`src/dungeons/driving/ui/`): JevPilot's scene (Model
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
  50 ms, turn-based and real-time. JevPilot under the same conditions
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

Not done (see *Pick up here*): JevPilot's full-world inspector tab (a
perception tab stands in), evaluation mode, and four scenario levels.
Manual driving and touch controls are a separate, undecided question
(*Decisions*).

### Pick up here

Finish milestone 3, in this order, each a commit with its tests, checks,
and a *Progress* entry:

1. **The inspector's world tab.** Port JevPilot's full-world JSON tab
   (its `observation(true)`: junctions with signals, roads, static
   objects, traffic controls, vehicles, pedestrians, the planned route,
   occluded ids) into `src/dungeons/driving/ui/inspector.ts`, built from
   the worker's snapshot; keep the perception tab. Read JevPilot's
   `src/simulation.js` `observation()` and `src/main.js` inspector.
2. **Evaluation mode.** A run option that turns off the safety brake
   (`sim.safety = false`) and the candidate filter's collision exclusion
   (`movingCandidates` in `decide/selection.ts`, and the plan's
   `safe` filter in `sim/plan.ts`), so a decider's choice decides the
   outcome. Expose it as a lobby toggle and an `eval`/`check` flag
   (`--evaluation`), carry it in `RunResult`, and record it in every
   result. Default runs must stay bit-identical (run
   `driving-reference.ts`). Then measure: rule and random (and `laya`,
   `laya-multilingual` if time allows) on town, city, highway seeds 1–4
   with and without it, a table in *Progress* naming machine, deciders,
   seeds, commit, and nuclis version.
3. **Scenario levels**, each a deterministic setup in `driving.ts` like
   `stop-line` (place the car, freeze or script the other agents, hold a
   signal) with a stated pass bound, a test that the rule passes it, and
   a `bun run check` entry: a stop sign with an earlier arrival (yield,
   then go once the other car clears), a merge gap (match an interstate
   gap from the on-ramp without contact), a blocked lane (a stopped car
   ahead: stop within 2.5 m without contact, or pass when allowed),
   off-road recovery (start off the asphalt: back on the route within a
   time bound without hitting a building). Add each to the lobby and to
   `scripts/driving-check.ts` with a screenshot.

Then milestone 4 (text dungeons) per *Milestones*.
