# Notice

## Code origin

Decision Dungeons rewrites parts of **JevPilot** by Standard Agents
(<https://github.com/standardagents/jevpilot>), used with permission.
Nothing is copied: JevPilot was read to learn what it does, and the
behaviour was implemented again in this project's own structure. What
comes from it so far:

- the nuclis decider and the idea of rewriting a request for a
  short-budget model;
- the TypeSafe Jev decider, its pricing, and its error handling;
- the debug sidebar's content and look, and the visual language of the UI
  (light glass panels, typography, colours);
- the driving dungeon: its worlds, simulation, candidate planner, and
  request (`src/dungeons/driving/{world,sim,decide}`), and its 3D scene,
  HUD, minimap, candidate paths, inspector, and crash effects
  (`src/dungeons/driving/ui`). Its assets are listed below.

## Third-party software

| Package | Version | License | Use |
| --- | --- | --- | --- |
| [lucide](https://lucide.dev) | 0.577.0 | ISC (portions MIT, from Feather) | icons, bundled into the UI |
| [@phosphor-icons/core](https://phosphoricons.com) | 2.1.1 | MIT, © 2023 Phosphor Icons | interface icons, SVGs bundled into the UI |
| [@fontsource-variable/fraunces](https://fontsource.org/fonts/fraunces) | 5.3.0 | SIL OFL 1.1, © 2020 The Fraunces Project Authors | display face (titles, dungeon names), woff2 bundled into the UI |
| [three](https://threejs.org) | 0.183.2 | MIT, © 2010–2026 three.js authors | the driving dungeon's 3D scene, with its glTF, Draco, and HDR loaders |
| [@fontsource-variable/dm-sans](https://fontsource.org/fonts/dm-sans) | 5.3.0 | SIL OFL 1.1, © 2014 The DM Sans Project Authors | text face, woff2 bundled into the UI |

The font license texts travel with the packages (`LICENSE` in each).

## Interface icons from game-icons.net

Dungeon and decider marks in `src/ui/icons/game/` are from
[game-icons.net](https://game-icons.net), licensed
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/); the settings
page credits them. Each icon's black background was removed and its fill
set to `currentColor`; the shapes are unchanged.

| Icon | Author |
| --- | --- |
| Dungeon gate, City car, Traffic lights red, Crossroad, Horizon road, Traffic cone, Rule book, Dice six faces five, Torch | [Delapouite](https://delapouite.com) |
| Fluffy cloud | [Lorc](https://lorcblog.blogspot.com) |

The app icon set in `public/icons/` is this project's own work.
Development tools (TypeScript, Biome, Bun's types) are not shipped.

## Assets

Copied from JevPilot's `public/` with their license and attribution files,
which travel with them; served by `src/server/assets.ts`.

| Asset | Files | Author | License |
| --- | --- | --- | --- |
| Tesla Model Y 2021 | `public/models/model-y/` | [763468712](https://sketchfab.com/763468712), adapted by Tina 3D Tesla and JevPilot | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), attribution required (see `ATTRIBUTION.md`, `LICENSE.txt` there) |
| tree_small_02, shrub_01, street_lamp_01 | `public/models/*/` | [Poly Haven](https://polyhaven.com) | [CC0](https://polyhaven.com/license) |
| Asphalt, pavement, brick, grass, and bark textures; the daylight sky (kloofendal_48d_partly_cloudy_puresky) | `public/textures/` | [Poly Haven](https://polyhaven.com) | [CC0](https://polyhaven.com/license) |
| Draco decoder | `public/draco/` | Google ([draco](https://github.com/google/draco)), as distributed with three.js | Apache 2.0 |

Tesla names and emblems identify the depicted vehicle; this project is not
affiliated with Tesla. JevPilot's three.js Ferrari model is not copied: its
renderer never used it.
