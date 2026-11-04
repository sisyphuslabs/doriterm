import * as dark from "./library-dark.ts";
import * as light from "./library-light.ts";

/**
 * Well-known terminal themes, built in beside doriface's own. Values come from each project's terminal palette as
 * collected by iTerm2-Color-Schemes (MIT, https://github.com/mbadolato/iTerm2-Color-Schemes); each theme keeps its own
 * project's licence, named in its credit below and in THEMES.md. Where an export inverts the selection (selection text
 * in a second colour doriface's palette does not carry), the selection is the background tinted toward ansi4 instead.
 */
export interface ThemeCredit {
  readonly name: string;
  /** The project the palette comes from, shown under the name. */
  readonly family: string;
  readonly url: string;
  /** SPDX id of the project's licence. */
  readonly licence: string;
}

/** Every library palette by id, dark themes first. */
export const LIBRARY_PALETTES = {
  dracula: dark.dracula,
  nord: dark.nord,
  "gruvbox-dark": dark.gruvboxDark,
  "solarized-dark": dark.solarizedDark,
  "one-dark": dark.oneDark,
  "tokyo-night": dark.tokyoNight,
  "catppuccin-mocha": dark.catppuccinMocha,
  "catppuccin-macchiato": dark.catppuccinMacchiato,
  "rose-pine": dark.rosePine,
  "kanagawa-wave": dark.kanagawaWave,
  "everforest-dark": dark.everforestDark,
  "ayu-dark": dark.ayuDark,
  "github-dark": dark.githubDark,
  "night-owl": dark.nightOwl,
  "tomorrow-night": dark.tomorrowNight,
  nightfox: dark.nightfox,
  "iceberg-dark": dark.icebergDark,
  "flexoki-dark": dark.flexokiDark,
  "solarized-light": light.solarizedLight,
  "gruvbox-light": light.gruvboxLight,
  "catppuccin-latte": light.catppuccinLatte,
  "rose-pine-dawn": light.rosePineDawn,
  "tokyo-night-day": light.tokyoNightDay,
  "one-light": light.oneLight,
  "github-light": light.githubLight,
  "ayu-light": light.ayuLight,
  "everforest-light": light.everforestLight,
  "kanagawa-lotus": light.kanagawaLotus,
  tomorrow: light.tomorrow,
  "light-owl": light.lightOwl,
  dayfox: light.dayfox,
  "iceberg-light": light.icebergLight,
  alabaster: light.alabaster,
  "selenized-light": light.selenizedLight,
  "flexoki-light": light.flexokiLight,
  "one-half-light": light.oneHalfLight,
} as const;

export type LibraryThemeName = keyof typeof LIBRARY_PALETTES;

export const LIBRARY_CREDITS: Readonly<Record<LibraryThemeName, ThemeCredit>> = {
  dracula: { name: "Dracula", family: "Dracula", url: "https://github.com/dracula/dracula-theme", licence: "MIT" },
  nord: { name: "Nord", family: "Nord", url: "https://github.com/nordtheme/nord", licence: "MIT" },
  "gruvbox-dark": {
    name: "Gruvbox Dark",
    family: "Gruvbox",
    url: "https://github.com/gruvbox-community/gruvbox",
    licence: "MIT",
  },
  "solarized-dark": {
    name: "Solarized Dark",
    family: "Solarized",
    url: "https://github.com/altercation/solarized",
    licence: "MIT",
  },
  "one-dark": { name: "One Dark", family: "Atom", url: "https://github.com/atom/one-dark-syntax", licence: "MIT" },
  "tokyo-night": {
    name: "Tokyo Night",
    family: "Tokyo Night",
    url: "https://github.com/folke/tokyonight.nvim",
    licence: "Apache-2.0",
  },
  "catppuccin-mocha": {
    name: "Catppuccin Mocha",
    family: "Catppuccin",
    url: "https://github.com/catppuccin/catppuccin",
    licence: "MIT",
  },
  "catppuccin-macchiato": {
    name: "Catppuccin Macchiato",
    family: "Catppuccin",
    url: "https://github.com/catppuccin/catppuccin",
    licence: "MIT",
  },
  "rose-pine": {
    name: "Rosé Pine",
    family: "Rosé Pine",
    url: "https://github.com/rose-pine/rose-pine-theme",
    licence: "MIT",
  },
  "kanagawa-wave": {
    name: "Kanagawa Wave",
    family: "Kanagawa",
    url: "https://github.com/rebelot/kanagawa.nvim",
    licence: "MIT",
  },
  "everforest-dark": {
    name: "Everforest Dark",
    family: "Everforest",
    url: "https://github.com/sainnhe/everforest",
    licence: "MIT",
  },
  "ayu-dark": { name: "Ayu Dark", family: "Ayu", url: "https://github.com/ayu-theme/ayu-colors", licence: "MIT" },
  "github-dark": {
    name: "GitHub Dark",
    family: "GitHub",
    url: "https://github.com/primer/github-vscode-theme",
    licence: "MIT",
  },
  "night-owl": {
    name: "Night Owl",
    family: "Night Owl",
    url: "https://github.com/sdras/night-owl-vscode-theme",
    licence: "MIT",
  },
  "tomorrow-night": {
    name: "Tomorrow Night",
    family: "Tomorrow",
    url: "https://github.com/chriskempson/tomorrow-theme",
    licence: "MIT",
  },
  nightfox: { name: "Nightfox", family: "Nightfox", url: "https://github.com/EdenEast/nightfox.nvim", licence: "MIT" },
  "iceberg-dark": {
    name: "Iceberg Dark",
    family: "Iceberg",
    url: "https://github.com/cocopon/iceberg.vim",
    licence: "MIT",
  },
  "flexoki-dark": { name: "Flexoki Dark", family: "Flexoki", url: "https://github.com/kepano/flexoki", licence: "MIT" },
  "solarized-light": {
    name: "Solarized Light",
    family: "Solarized",
    url: "https://github.com/altercation/solarized",
    licence: "MIT",
  },
  "gruvbox-light": {
    name: "Gruvbox Light",
    family: "Gruvbox",
    url: "https://github.com/gruvbox-community/gruvbox",
    licence: "MIT",
  },
  "catppuccin-latte": {
    name: "Catppuccin Latte",
    family: "Catppuccin",
    url: "https://github.com/catppuccin/catppuccin",
    licence: "MIT",
  },
  "rose-pine-dawn": {
    name: "Rosé Pine Dawn",
    family: "Rosé Pine",
    url: "https://github.com/rose-pine/rose-pine-theme",
    licence: "MIT",
  },
  "tokyo-night-day": {
    name: "Tokyo Night Day",
    family: "Tokyo Night",
    url: "https://github.com/folke/tokyonight.nvim",
    licence: "Apache-2.0",
  },
  "one-light": { name: "One Light", family: "Atom", url: "https://github.com/atom/one-light-syntax", licence: "MIT" },
  "github-light": {
    name: "GitHub Light",
    family: "GitHub",
    url: "https://github.com/primer/github-vscode-theme",
    licence: "MIT",
  },
  "ayu-light": { name: "Ayu Light", family: "Ayu", url: "https://github.com/ayu-theme/ayu-colors", licence: "MIT" },
  "everforest-light": {
    name: "Everforest Light",
    family: "Everforest",
    url: "https://github.com/sainnhe/everforest",
    licence: "MIT",
  },
  "kanagawa-lotus": {
    name: "Kanagawa Lotus",
    family: "Kanagawa",
    url: "https://github.com/rebelot/kanagawa.nvim",
    licence: "MIT",
  },
  tomorrow: {
    name: "Tomorrow",
    family: "Tomorrow",
    url: "https://github.com/chriskempson/tomorrow-theme",
    licence: "MIT",
  },
  "light-owl": {
    name: "Light Owl",
    family: "Night Owl",
    url: "https://github.com/sdras/night-owl-vscode-theme",
    licence: "MIT",
  },
  dayfox: { name: "Dayfox", family: "Nightfox", url: "https://github.com/EdenEast/nightfox.nvim", licence: "MIT" },
  "iceberg-light": {
    name: "Iceberg Light",
    family: "Iceberg",
    url: "https://github.com/cocopon/iceberg.vim",
    licence: "MIT",
  },
  alabaster: {
    name: "Alabaster",
    family: "Alabaster",
    url: "https://github.com/tonsky/sublime-scheme-alabaster",
    licence: "MIT",
  },
  "selenized-light": {
    name: "Selenized Light",
    family: "Selenized",
    url: "https://github.com/jan-warchol/selenized",
    licence: "MIT",
  },
  "flexoki-light": {
    name: "Flexoki Light",
    family: "Flexoki",
    url: "https://github.com/kepano/flexoki",
    licence: "MIT",
  },
  "one-half-light": {
    name: "One Half Light",
    family: "One Half",
    url: "https://github.com/sonph/onehalf",
    licence: "MIT",
  },
};
