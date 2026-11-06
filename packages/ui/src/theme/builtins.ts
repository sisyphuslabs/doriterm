import { LIBRARY_CREDITS, LIBRARY_PALETTES } from "./library.ts";
import type { Palette } from "./palette.ts";

/** doriface's own dark default: warm near-black, parchment ink. */
export const night: Palette = {
  background: 0x161513,
  foreground: 0xd8d4cb,
  selection: 0x3a3e4c,
  status: [0xe2b86b, 0xef7d6b, 0x7fa8f5],
  ansi: [
    0x4a4640, 0xe08a7e, 0xa9c08f, 0xdcbb7f, 0x9fb4e6, 0xc4a6d6, 0x8fc2bb, 0xd8d4cb, 0x8a857d, 0xf0a59a, 0xbfd6a6,
    0xecd29f, 0xbccbf2, 0xd7bde6, 0xa9d6cf, 0xf4f1ea,
  ],
};

/** doriface's own light default: warm bone paper, ink-dark text. Bright white is ink, as in paper. */
export const day: Palette = {
  background: 0xfbfaf7,
  foreground: 0x2a2723,
  selection: 0xd6e0f5,
  cursor: 0x2a2723,
  status: [0x8a5a00, 0xbf3a2b, 0x2f5fc4],
  ansi: [
    0x2a2723, 0xb8322a, 0x2f7a3a, 0x8a5a00, 0x2f5fc4, 0x7b4ab8, 0x12707a, 0x5e5a54, 0x726d66, 0xc03c2e, 0x2a7d3f,
    0x8f6000, 0x2257c0, 0x7d4cc4, 0x137680, 0x161411,
  ],
};

/** herdr-app's `graphite` preset (its dark default). */
export const graphite: Palette = {
  background: 0x17191d,
  foreground: 0xd2d4d9,
  selection: 0x394454,
  status: [0xe5c07b, 0xf0705f, 0x76a8ff],
  ansi: [
    0x45484f, 0xdc8c95, 0xa6bd91, 0xd8be87, 0x96b2d7, 0xb5a2ce, 0x8cbdc3, 0xd2d4d9, 0x818793, 0xf0a5ad, 0xbad5a2,
    0xead2a1, 0xb0cbef, 0xcbb7e6, 0xa4d5db, 0xf0f0f2,
  ],
};

/** herdr-app's `paper` preset (its light default). */
export const paper: Palette = {
  background: 0xffffff,
  foreground: 0x25272c,
  selection: 0xcfdcf5,
  cursor: 0x25272c,
  status: [0x9a6700, 0xc93c2c, 0x2f6fe4],
  ansi: [
    0x25272c, 0xc62a2a, 0x1a7f37, 0x8f5d00, 0x1f62d0, 0x7a45c8, 0x0f6f74, 0x5f6068, 0x7b7e87, 0xd1242f, 0x1f883d,
    0x9a6700, 0x0969da, 0x8250df, 0x1b7c83, 0x111214,
  ],
};

/** doriface's and herdr-app's own presets, which the generated themes.css pins by `data-theme`. */
export const CORE_PALETTES = { night, day, graphite, paper } as const;

export const BUILTIN_PALETTES = { ...CORE_PALETTES, ...LIBRARY_PALETTES } as const;
export type BuiltinThemeName = keyof typeof BUILTIN_PALETTES;

export const isBuiltinThemeName = (id: string): id is BuiltinThemeName => Object.hasOwn(BUILTIN_PALETTES, id);

/** How a built-in theme is named and credited in the picker. */
export interface BuiltinThemeInfo {
  readonly name: string;
  /** Where it comes from: Doriterm, herdr-app, or the upstream project. */
  readonly family: string;
  /** The upstream project and its SPDX licence id, for library themes. */
  readonly url?: string;
  readonly licence?: string;
}

export const BUILTIN_THEMES: Readonly<Record<BuiltinThemeName, BuiltinThemeInfo>> = {
  night: { name: "Night", family: "Doriterm" },
  day: { name: "Day", family: "Doriterm" },
  graphite: { name: "Graphite", family: "herdr-app" },
  paper: { name: "Paper", family: "herdr-app" },
  ...LIBRARY_CREDITS,
};
