# @doriface/ghostty-wasm

`ghostty-vt.wasm` for `@wterm/ghostty` 0.5.9, rebuilt from Ghostty v1.4.0 instead of the v1.3.1 source that
`@wterm/ghostty` 0.5.9 ships.

```ts
import { loadGhosttyCore } from "@doriface/ghostty-wasm";
import { Terminal } from "@wterm/react";

const core = await loadGhosttyCore({ scrollbackLimit: 8_000_000 });
// <Terminal core={core} ... />
```

`ghosttyWasmUrl` is exported for callers that build their own `GhosttyCore.load({ wasmPath })` options, and
`ghosttyBuild` exposes `wasm/build.json`.

## How the binary is built

`@wterm/ghostty` does not load Ghostty's own C API. It loads wterm's Zig export layer
(`packages/@wterm/ghostty/zig` in wterm), compiled against Ghostty. `bun run build:wasm` fetches both by commit,
checks their archive digests, applies `patches/`, builds with the pinned Zig 0.17.0 (the minimum Ghostty v1.4.0
accepts), and writes `wasm/ghostty-vt.wasm` and `wasm/build.json`. `bun run build:wasm --ref <tag|commit>` builds
another Ghostty revision into the same two files, overwriting the committed ones; an unpinned revision has its
archive digest recorded rather than checked. Commit only a pinned build: to move to another revision, change
`scripts/pins.ts` first, because `scripts/verify.ts` rejects a `build.json` whose revisions differ from the pins.

| Patch          | Why                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ghostty/0001` | Ghostty v1.4.0 turns Kitty graphics off for every freestanding target; WebAssembly keeps them, with file and shared-memory media refused.                  |
| `ghostty/0002` | Counts evicted Kitty images for `getResourceState().graphics.evicted`.                                                                                     |
| `ghostty/0003` | Counts scrollback rows pruned from the top, for `get_scrollback_discarded_count`.                                                                          |
| `ghostty/0004` | Makes the stream's `print` and `csiDispatch` public for the export layer's fast paths.                                                                     |
| `ghostty/0005` | Caps resident Kitty image and placement metadata at 4096 each on WebAssembly, whose memory never shrinks; see below for what happens at the cap.           |
| `wterm/0001`   | Ports the export layer to Zig 0.17 and the Ghostty v1.4.0 API (`std.Io`, terminal stream effects, compressed pages, image data union, glyph protocol APC). |
| `wterm/0002`   | Answers the OSC 7501 Program Status probe and keeps the root status record, readable through `get_program_status_*`.                                       |

CI does not rebuild Zig. `scripts/verify.ts` checks that the committed wasm, its size, and every patch match
`wasm/build.json`, and that `wasm/build.json` names the pinned revisions and Zig.

## Kitty metadata cap

At 4096 resident images (or placements), a command that would add a new one is refused with `ENOMEM` instead of
evicting the oldest. This is the behavior of the stock 0.5.9 binary, whose wterm build patches its Ghostty the same
way: it keeps a full byte-eviction scan off the path of every metadata-only overflow, so the resident set stays
bounded until a program deletes images or byte-budget eviction frees room.

## Differences from the stock 0.5.9 binary

wterm's own `@wterm/ghostty` suite (187 tests at 0.5.8) passed on the 0.5.8 build of this binary except two cases
that pin v1.3.1 behavior; the 0.5.9 suite has not been run against this build:

- An ANSI-mode DECRQM (`CSI 4 $ p`) now gets a DECRPM reply; Ghostty v1.3.1 never dispatched it.
- 4096 repeated Kitty placements settle at about 2.4 MiB of WebAssembly memory instead of about 1.3 MiB; the
  plateau is the same, but the per-placement metadata of v1.4.0 is larger.

`set_scrollback_lines` is also implemented differently, because its upstream shape needs Ghostty v1.3.1 internals:
here it calls Ghostty v1.4.0's `PageList.setMaxLines`, which prunes whole historical pages and always keeps at least
one standard page, so a limit of `0` does not clear the history and the retained count can sit slightly above the
limit. Stock 0.5.9 converts lines to a page byte budget and erases rows hidden past the limit through Ghostty's
private `eraseRows`; those rows do not exist on this build, so `get_scrollback_discarded_count` counts only the rows
pruning discarded. The web app is unaffected today: `terminal-view.tsx` always passes `scrollbackLimit` in bytes, so
`GhosttyCore` never calls the line limit at all.
