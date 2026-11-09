# The pinned e2e faces

`pinned-ui.woff2` and `pinned-hangul.woff2` exist so the Web e2e suite measures the same boxes on a Linux runner and on
a developer's Mac (#862). `e2e/pinned-fonts.ts` injects them, as test-only families, before the app's scripts. They are
not product fonts and are not shipped.

| file                  | family       |  bytes | sha256                                                             |
| --------------------- | ------------ | -----: | ------------------------------------------------------------------ |
| `pinned-ui.woff2`     | `E2E UI`     | 79,416 | `6858bef5170c5243988caa0dbd1d0ef66e8a0a73d797adcfa7d74488054c52a2` |
| `pinned-hangul.woff2` | `E2E Hangul` | 33,636 | `5782072a1042909b6ea0cc5e3f6db9c9dc8e21b1960ee416cd6a4a72d839c3f7` |

## Rebuilding

```sh
uv run --python 3.13 --with fonttools==4.68.0 --with brotli==1.2.1 python make-pinned-fonts.py
```

The script downloads the two sources, checks their SHA-256, and writes both files. Both sources are SIL Open Font
License 1.1; the licence and copyright notices are in `OFL.txt`.

- `pinned-ui.woff2` is [Inter 4.1](https://github.com/rsms/inter/releases/tag/v4.1) `InterVariable.ttf`
  (`sha256 4989b125924991b90d05b2d16e0e388c48f7d5bb8b30539bbf9c755278d0ccaf`), instantiated at `opsz 14 / wght 400`
  and subset to these ranges:

  `U+0020-007E`, `U+00A0-00FF`, `U+2000-20CF`, `U+2100-214F`, `U+2190-23FF`, `U+25A0-27BF`, `U+FB00-FB06`, `U+FEFF`, `U+FFFD`.

  The general-punctuation block carries the ellipsis a truncated header draws; the arrow and miscellaneous-technical
  blocks carry the shortcut chips. Layout features are fontTools' defaults, so kerning stays.

- `pinned-hangul.woff2` is [Noto Sans KR Regular](https://github.com/notofonts/noto-cjk)
  (`sha256 69975a0ac8472717870aefeab0a4d52739308d90856b9955313b2ad5e0148d68`), subset to every Hangul syllable in
  `apps/web/e2e`, `apps/web/src` and `packages/ui/src` (169 syllables today, literals and `\uXXXX` escapes alike) plus
  the Hangul compatibility jamo block `U+3130-318F`. The script rescans those trees on every run, so a new Hangul string
  in a test is included by rebuilding. Conjoining jamo (`U+1100-11FF`) are deliberately left out: they enter only as IME
  input, whose composition box is counted in cells, so no test measures their ink, and they cost 222 kB.

Both faces keep their internal names (`E2E UI`, `E2E Hangul`), so a modified version does not use the upstream reserved
names. Syllables a spec generates rather than writes (`terminal-wide-measure.e2e.ts` draws U+AC00 onwards) are not in
the subset and fall back to the platform; that spec counts canvas measurements, not glyph ink. `e2e-hangul.otf` in the
parent directory is a separate, older five-syllable fixture used by `terminal-selection-cells.e2e.ts`; it is unchanged.
