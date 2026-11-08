# herdr-app's default keys, vendored

`keys.json` and `keys.macos.json` are byte-for-byte copies of herdr-app's `defaults/keys.json` and
`defaults/keys.macos.json`:

- Repository: https://github.com/herdrdev/herdr-app
- Commit: `cfcf836404f932817f10f88455c33e33c94fd1df`
- License: Apache-2.0 (herdr-app's `LICENSE`)

herdr-app reads `keys.macos.json` on macOS and `keys.json` everywhere else. doriface does not load these files at run
time: `herdr-app-parity.test.ts` compares doriface's default keymap (`defaults.ts`) with them, and
`docs/keymap-herdr-app.md` is generated from the same comparison (`bun apps/web/scripts/keymap-table.ts`).

To follow a newer herdr-app, copy both files from its `defaults/` at that commit, update the commit here and in
`herdr-app-defaults.ts`, then run the parity test: every changed default fails it until `defaults.ts` follows it or
`herdr-app-parity.ts` records why doriface differs.
