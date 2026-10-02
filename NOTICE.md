# Notice

## Code origin

Decision Dungeons rewrites parts of **JevPilot** by Standard Agents
(upstream commit `e1beeb1`, with the `nuclis-decider` branch at `4cca4fc`),
used with permission. Nothing is copied: JevPilot was read to learn what
it does, and the behaviour was implemented again in this project's own
structure. What comes from it so far:

- the nuclis decider (`nuclis decide` as a subprocess) and the idea of
  rewriting a request for a short-budget model;
- the TypeSafe Jev decider, its pricing, and its error handling;
- the debug sidebar's content and look, and the visual language of the UI
  (light glass panels, typography, colours).

The driving dungeon, when it lands, is a rewrite of JevPilot's simulator
and scene; its assets will be listed below with their licenses.

## Third-party software

| Package | Version | License | Use |
| --- | --- | --- | --- |
| [lucide](https://lucide.dev) | 0.577.0 | ISC (portions MIT, from Feather) | icons, bundled into the UI |

Development tools (TypeScript, Biome, Bun's types) are not shipped.

## Assets

None yet.
