# Decision Dungeons — plan

A local playground for decision models. Each **dungeon** is a world that
asks a decider typed questions about what it sees; the player picks the
dungeon, its level, and the **autopilot** (which decider, which model), then
watches it play, with a debug sidebar showing what the decider read and
answered. The same dungeons run headless and produce comparison tables.

Status: agreed 2026-10-02; milestone 1 (the skeleton) is built, milestone
2 is next (*Progress*). A new session starts at *Start here* below.

## Start here

1. Read this plan, then `AGENTS.md`.
2. Read the references below, in that order, before writing code.
3. Begin milestone 1. Record what each session delivered in *Progress*
   at the end of this file.

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
- **three.js** for the driving dungeon; **lucide** icons.
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
    lib/           seeded randomness
    server/        Bun.serve: routes, config store, decide endpoint
    dungeons/
      dungeon.ts   the Dungeon interface; turn.ts, one decision turn
      crossing/    the stop-line quiz (milestone 1's test bed)
      driving/
        world/     road graph, worlds (town, city, highway), routing
        sim/       vehicles, traffic, signals, collisions, safety brake
        decide/    observation → request, answers → controls, rule baseline
        checks/    scenario checks (stop line, …) with pass/fail bounds
        ui/        three.js scene, HUD, minimap, candidates, inspector
      registry.ts
    ui/            shell: start screen, config page, debug sidebar, tooltips
    cli/           eval and check runners
  tests/
  scripts/         browser-check.ts (headless UI check, screenshots)
  public/          assets with their licenses and attributions
  NOTICE.md
```

The dungeon interface keeps the simulation headless and deterministic:

```ts
interface Dungeon<Run> {
  id: string; title: string; levels: Level[];
  create(seed: number, level: string): Run;
  observe(run: Run): { request: Request; resolved?: Answers }; // local answers when one option
  apply(run: Run, answers: Answers): void;
  step(run: Run, dt: number): void;
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
- Bound to `127.0.0.1` (port 4317, `DECISION_DUNGEONS_PORT`). Every API
  route requires a loopback `Host` header; writes must be same-origin
  `application/json`, because the config names a binary the server runs.

## The start screen and the debug sidebar

- Start: pick a dungeon, a level, an autopilot (decider and model, the
  unconfigured ones shown disabled with the reason), a seed; play.
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
- The planner worker stays a worker, bundled by Bun.
- Hosted pieces (OAuth, play credit, Durable Objects, Cloudflare Worker)
  are left out.
- **A turn-based mode**: simulated time pauses while the autopilot
  decides, so a slow decider (clef-flash, about 1–3 s) plays the same
  game as a fast one and latency never enters the score. Real-time stays
  the default for watching fast deciders.
- **An evaluation mode** that turns the safety brake and the candidate
  filter's collision exclusion off, because JevPilot showed they make any
  decider arrive (random arrived on 12 of 12 trips).
- Scenario checks are first-class levels: the red-light stop line first,
  then a stop sign with an earlier arrival, a merge gap, a blocked lane,
  and off-road recovery, each with a pass bound and run by every decider.

**Proving the port.** The rule decider is deterministic, so it is the
oracle: for seeds 1–4 in each world and for the stop-line check, the port
and JevPilot (`e1beeb1` plus the `nuclis-decider` branch) must arrive
alike, with the same violations and stop distances within 0.1 m.
Differences are explained or fixed before the UI work.

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
- Dependencies: lucide 0.577.0 (icons, as JevPilot); dev only TypeScript
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
- A fifth decide error, `unavailable` (cannot reach the decider, HTTP 5xx,
  cancelled), beside `unconfigured`, `rejected`, `timeout`, and
  `invalid_answer` (2026-10-02).
- The server listens on `127.0.0.1:4317` (`DECISION_DUNGEONS_PORT`); API
  routes require a loopback `Host` (DNS rebinding) and same-origin JSON
  writes (cross-site requests), since the config page can set the binary
  the server runs (2026-10-02).
- The UI fetches nothing from the network: DM Sans and Manrope are used
  when installed, else the system font (2026-10-02).

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

**Pick up at milestone 2**: the driving world, simulation, decision state,
rule baseline, and checks, headless; `bun run eval` and `bun run check`
over `playTurn`'s results; then the port matched against JevPilot with
the rule decider as *Proving the port* describes. Read JevPilot's
`src/simulation.js`, `src/driving-plan.js`, `src/planning.js`,
`src/world.js`, `src/highway.js`, and `scripts/verify-*.mjs` first.
