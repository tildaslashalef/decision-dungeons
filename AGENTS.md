# AGENTS.md — Decision Dungeons

Instructions for coding agents working in this repository.

## Project and sources of truth

Decision Dungeons is a local playground for decision models: each dungeon is a
seeded world that asks a decider typed questions, and the player picks the
dungeon, its level, and the autopilot (decider and model), then watches it
play or runs it headless for comparison tables. The first dungeon is
autopilot driving, a rewrite of Standard Agents' JevPilot.

[docs/plan.md](docs/plan.md) is the plan: its context, references,
architecture, milestones, decisions, and *Progress*. Read it first, every
session. There is no other roadmap.

## Sessions

- **Start** by reading `docs/plan.md` § *Progress*. If a milestone is in
  progress, summarize where it stands and continue it; otherwise ask what
  to work on.
- **End** by updating *Progress*: what the session delivered (with the
  commands and numbers that prove it), what remains, where to pick up. The
  hand-off is the plan, never the conversation.
- A decision that outlives a session (a dependency, a format, a rule) goes
  into *Decisions* with its date, in the commit that acts on it.

## Working mode

Act as an implementation collaborator: design, implement, test, review,
and document the requested work. Complete authorized work without
unnecessary confirmation; raise material ambiguity with a concrete
recommendation. Inspect existing files and diffs before changing them, and
remove stale guidance instead of keeping competing versions.

## References

- **JevPilot** (`~/Code/jevpilot`, branch `nuclis-decider`) is the
  reference for the driving dungeon's look and behaviour, used with
  permission. **Rewrite, do not copy**: read it to learn what it does,
  then implement our structure (typed modules, a store, headless
  simulation). Never paste its files wholesale. Its assets (models,
  textures, sky) are copied with their license and attribution files, and
  `NOTICE.md` records both the code's origin and every asset's license.
- **nuclis** (`~/Code/nuclis`) is a black box reached through its CLI
  (`nuclis decide`, `nuclis model ls --json`) or, once it lands, `nuclis
  serve`'s HTTP API. Never import its code or depend on its file layout
  beyond what those commands print.
- **TypeSafe Jev** is reached only through its public HTTPS API.

## Bun and TypeScript

- **Bun 1.4 only.** `bun install`, `bun add`, `bun run`, `bun test`,
  `bunx`. Never `npm`, `npx`, `yarn`, `pnpm`, or `node`; `bun.lock` is the
  only lockfile and is committed. Pin exact versions of direct
  dependencies; add one only when it removes real work, and say why in
  the commit.
- **Server code** uses Bun's APIs (`Bun.serve` with HTML imports,
  `Bun.spawn`, `Bun.file`, `Bun.write`); **browser code** uses web APIs
  only. Nothing under `src/` that the browser loads imports a Bun or Node
  module.
- **TypeScript strict** (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`), ES modules. No `any` without a comment
  saying why; parse untrusted JSON into typed values at the boundary.
- **Formatting and linting:** Biome (`bunx biome check --write`); types:
  `bunx tsc --noEmit`. Both clean before a commit.

## Architecture rules

- **Dungeons and deciders never know each other.** A dungeon turns its
  state into a request and answers into actions; a decider turns a
  request into answers. The request and answer types in `src/contract/`
  are Jev's shape, the interface `nuclis decide` already speaks.
- **Simulations are headless and deterministic.** All randomness comes
  from a seeded generator passed in; no `Math.random`, wall-clock time, or
  DOM in `dungeons/*/world`, `sim`, or `decide`. The same seed and
  decisions give the same run, in the browser and in `bun run eval`.
- **One result type, two views.** The UI and the CLI render the same
  result objects; machine-readable output is never scraped from text.
- **Deciders are validated, not trusted.** An answer naming an option that
  was not offered, a probability that is not finite, or a missing question
  is a typed error, never a crash and never silently repaired.
- **Fields a decider does not report are omitted**, never filled with
  defaults that look like measurements.

## Security and user data

- `~/.decision-dungeons/` holds the config (`config.json`, mode 600);
  `DECISION_DUNGEONS_HOME` may override it with an absolute path.
- API keys live only on the server: environment variables or the config
  file. The browser may set a key but never reads one back; keys never
  enter logs, responses, or error messages.
- The server binds to `127.0.0.1` by default; request bodies, decider
  calls, and concurrent decisions are bounded with host constants and
  timeouts.
- Never commit keys, `.env` files, `~/.decision-dungeons` contents, run
  artifacts, or screenshots of private data.

## Validation and definition of done

For code changes:

1. `bun test` (contract, deciders with a fake `nuclis` binary, dungeon
   logic, error paths), `bunx tsc --noEmit`, `bunx biome check`.
2. A change to a simulation or a decider: run `bun run eval` on the
   affected dungeon and seeds; for the driving port, match JevPilot with
   the deterministic rule decider as `docs/plan.md` § *Proving the port*
   describes.
3. A change a player can see: start the dev server, drive it in a
   headless browser (Playwright through `bunx`), and look at the
   screenshots before calling it done; cite them in *Progress*.
4. Measurements name the machine, the decider and model, the seeds, the
   commit, and the nuclis version; never present an estimate as a
   measurement.
5. Report what changed, what was validated, and what remains.

Default tests need no network, no API key, no GPU, and no model download:
deciders are tested against fakes; runs against real nuclis or Jev are
explicit commands.

## Code comments

A comment earns its place by saying what the code cannot: an invariant, an
ownership rule, a non-obvious reason, a hazard. Module headers are a short
orientation; declarations get a one- or two-sentence contract; inline
comments give the non-obvious why, never the what. No history or plan
narration ("was X, now Y", "milestone 2"): a comment must stay true after
the plan is gone. Specifications live in `docs/`, linked, not restated.

## Commits

Use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/#specification):
`type(optional-scope): short description`. Use `feat` for features, `fix`
for bug fixes, and `docs`, `build`, `test`, `refactor`, `perf`, or `chore`
when those fit better. Scopes such as `driving`, `deciders`, `server`,
`ui`, and `cli` are optional. Mark breaking changes with `!` or a
`BREAKING CHANGE:` footer.

Commit each coherent, verified unit of work: a feature with its tests and
docs, a focused fix, or a self-contained documentation update. Do not
commit every small edit, and do not combine unrelated work into one large
commit. Inspect the staged diff and run the checks above before
committing. Short subjects; a body only when it explains a reason or a
tradeoff. **Do not add `Co-Authored-By:` or any other co-author or
attribution trailer.**

Routine local commits are authorized. The repository is local only: do
not add a remote, push, or publish.
