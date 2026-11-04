# Built-in themes

doriface ships 40 themes: its own Night and Day, herdr-app's Graphite and Paper, and 36 well-known terminal themes
(`library-dark.ts`, `library-light.ts`). Each library palette is the project's terminal palette (background,
foreground, selection, cursor, ansi0..15) as collected by
[iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) (MIT, Copyright (c) 2011 to Present Mark
Badolato); the colours of each theme belong to its own project under the licence listed below. Every licence here
(MIT, Apache-2.0) permits redistribution inside doriface (AGPL-3.0-only). Each project's copyright line and licence
text ship in `packages/ui/NOTICE`, the Apache License 2.0 text in `packages/ui/licenses/Apache-2.0.txt`.

Two changes are made, both recorded in code:

- **Selection.** Some exports invert the selection (selection background equal to the foreground, selected text in a
  second colour). doriface's palette has no selection text colour, so those themes use the background mixed toward
  ansi4 (at most 30 %) while terminal text stays readable on it (`library.test.ts`).
- **Contrast.** Terminal text, UI text, control edges and status glyphs pass the AA guard (`guard.ts`), as for every
  theme; a palette that already passes is unchanged.

## ANSI colours keep their project's contrast

The AA guard moves terminal text (the foreground) and the UI roles; it does not touch ansi0..15, so programs' coloured
output looks the way each project designed it. Doriface's own four presets keep every ANSI text colour (ansi1-6 and
ansi9-14) at 4.5:1 or more. These 18 library themes ship at least one below 3:1 on their own background, mostly yellow
on a light background:

| Theme              | Lowest ANSI text contrast |
| ------------------ | ------------------------- |
| `everforest-light` | 1.76                      |
| `alabaster`        | 1.78                      |
| `ayu-light`        | 1.82                      |
| `one-light`        | 1.86                      |
| `tomorrow`         | 1.86                      |
| `catppuccin-latte` | 1.87                      |
| `one-half-light`   | 1.90                      |
| `light-owl`        | 1.97                      |
| `rose-pine-dawn`   | 2.05                      |
| `gruvbox-light`    | 2.19                      |
| `flexoki-light`    | 2.31                      |
| `solarized-light`  | 2.48                      |
| `gruvbox-dark`     | 2.69                      |
| `kanagawa-lotus`   | 2.70                      |
| `solarized-dark`   | 2.79                      |
| `flexoki-dark`     | 2.85                      |
| `iceberg-light`    | 2.94                      |
| `selenized-light`  | 2.98                      |

Ghostty's remedy is `minimum-contrast`, which lifts any colour below the ratio it is set to. Settings > Terminal lists
it, but the web terminal cannot apply it yet (the DOM renderer has no per-cell contrast pass, so the row is disabled
with that reason). Until it can, `palette` in the same section overrides any ANSI colour (`3=#rrggbb`). Settings >
Appearance says this beside the picker when a picked theme is one of these (`ansiTextContrast` below 3:1).

## Themes

| Theme                | id                     | Kind  | Project                                                         | Licence    | Selection           |
| -------------------- | ---------------------- | ----- | --------------------------------------------------------------- | ---------- | ------------------- |
| Dracula              | `dracula`              | dark  | [Dracula](https://github.com/dracula/dracula-theme)             | MIT        | upstream            |
| Nord                 | `nord`                 | dark  | [Nord](https://github.com/nordtheme/nord)                       | MIT        | tinted toward ansi4 |
| Gruvbox Dark         | `gruvbox-dark`         | dark  | [Gruvbox](https://github.com/gruvbox-community/gruvbox)         | MIT        | upstream            |
| Solarized Dark       | `solarized-dark`       | dark  | [Solarized](https://github.com/altercation/solarized)           | MIT        | upstream            |
| One Dark             | `one-dark`             | dark  | [Atom](https://github.com/atom/one-dark-syntax)                 | MIT        | upstream            |
| Tokyo Night          | `tokyo-night`          | dark  | [Tokyo Night](https://github.com/folke/tokyonight.nvim)         | Apache-2.0 | upstream            |
| Catppuccin Mocha     | `catppuccin-mocha`     | dark  | [Catppuccin](https://github.com/catppuccin/catppuccin)          | MIT        | tinted toward ansi4 |
| Catppuccin Macchiato | `catppuccin-macchiato` | dark  | [Catppuccin](https://github.com/catppuccin/catppuccin)          | MIT        | tinted toward ansi4 |
| Rosé Pine            | `rose-pine`            | dark  | [Rosé Pine](https://github.com/rose-pine/rose-pine-theme)       | MIT        | upstream            |
| Kanagawa Wave        | `kanagawa-wave`        | dark  | [Kanagawa](https://github.com/rebelot/kanagawa.nvim)            | MIT        | tinted toward ansi4 |
| Everforest Dark      | `everforest-dark`      | dark  | [Everforest](https://github.com/sainnhe/everforest)             | MIT        | upstream            |
| Ayu Dark             | `ayu-dark`             | dark  | [Ayu](https://github.com/ayu-theme/ayu-colors)                  | MIT        | tinted toward ansi4 |
| GitHub Dark          | `github-dark`          | dark  | [GitHub](https://github.com/primer/github-vscode-theme)         | MIT        | tinted toward ansi4 |
| Night Owl            | `night-owl`            | dark  | [Night Owl](https://github.com/sdras/night-owl-vscode-theme)    | MIT        | upstream            |
| Tomorrow Night       | `tomorrow-night`       | dark  | [Tomorrow](https://github.com/chriskempson/tomorrow-theme)      | MIT        | upstream            |
| Nightfox             | `nightfox`             | dark  | [Nightfox](https://github.com/EdenEast/nightfox.nvim)           | MIT        | upstream            |
| Iceberg Dark         | `iceberg-dark`         | dark  | [Iceberg](https://github.com/cocopon/iceberg.vim)               | MIT        | tinted toward ansi4 |
| Flexoki Dark         | `flexoki-dark`         | dark  | [Flexoki](https://github.com/kepano/flexoki)                    | MIT        | upstream            |
| Solarized Light      | `solarized-light`      | light | [Solarized](https://github.com/altercation/solarized)           | MIT        | upstream            |
| Gruvbox Light        | `gruvbox-light`        | light | [Gruvbox](https://github.com/gruvbox-community/gruvbox)         | MIT        | tinted toward ansi4 |
| Catppuccin Latte     | `catppuccin-latte`     | light | [Catppuccin](https://github.com/catppuccin/catppuccin)          | MIT        | upstream            |
| Rosé Pine Dawn       | `rose-pine-dawn`       | light | [Rosé Pine](https://github.com/rose-pine/rose-pine-theme)       | MIT        | upstream            |
| Tokyo Night Day      | `tokyo-night-day`      | light | [Tokyo Night](https://github.com/folke/tokyonight.nvim)         | Apache-2.0 | tinted toward ansi4 |
| One Light            | `one-light`            | light | [Atom](https://github.com/atom/one-light-syntax)                | MIT        | upstream            |
| GitHub Light         | `github-light`         | light | [GitHub](https://github.com/primer/github-vscode-theme)         | MIT        | tinted toward ansi4 |
| Ayu Light            | `ayu-light`            | light | [Ayu](https://github.com/ayu-theme/ayu-colors)                  | MIT        | tinted toward ansi4 |
| Everforest Light     | `everforest-light`     | light | [Everforest](https://github.com/sainnhe/everforest)             | MIT        | upstream            |
| Kanagawa Lotus       | `kanagawa-lotus`       | light | [Kanagawa](https://github.com/rebelot/kanagawa.nvim)            | MIT        | tinted toward ansi4 |
| Tomorrow             | `tomorrow`             | light | [Tomorrow](https://github.com/chriskempson/tomorrow-theme)      | MIT        | upstream            |
| Light Owl            | `light-owl`            | light | [Night Owl](https://github.com/sdras/night-owl-vscode-theme)    | MIT        | upstream            |
| Dayfox               | `dayfox`               | light | [Nightfox](https://github.com/EdenEast/nightfox.nvim)           | MIT        | upstream            |
| Iceberg Light        | `iceberg-light`        | light | [Iceberg](https://github.com/cocopon/iceberg.vim)               | MIT        | tinted toward ansi4 |
| Alabaster            | `alabaster`            | light | [Alabaster](https://github.com/tonsky/sublime-scheme-alabaster) | MIT        | upstream            |
| Selenized Light      | `selenized-light`      | light | [Selenized](https://github.com/jan-warchol/selenized)           | MIT        | upstream            |
| Flexoki Light        | `flexoki-light`        | light | [Flexoki](https://github.com/kepano/flexoki)                    | MIT        | upstream            |
| One Half Light       | `one-half-light`       | light | [One Half](https://github.com/sonph/onehalf)                    | MIT        | upstream            |
