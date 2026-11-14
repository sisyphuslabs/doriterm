# #2555: phone-keyboard-toggle #1519 case saw one extra focus-out once (investigation)

Observed once: a full-suite receipt for #2506 at 50c0b34014 had e2e 1444 pass / 1 fail at phone-keyboard-toggle.e2e.ts:152 (outs 4 vs 2, i.e. two more ^[[O: one unmarked blur, reported by both the renderer and the view). Not reproduced: 10/10 alone (Linux and macOS) and 20/20 under pinned CPU pressure (Linux) at both dev 0c10bf2d and 50c0b34014.

1. Disproved: "the microtask that clears regaining runs before onBlur". The renderer reports focus synchronously inside the field's own blur/focus handlers (wterm patch, around lines 99-115), so a blur made inside the port's call is checked before that microtask.
2. Candidate: holdForPress's pointerup "lifted" path (apps/web/src/terminal/terminal-port.ts:122-128) refocuses when elementFromPoint at pointerup is not the button (a button moved under load), then the click's port.focus() blurs and refocuses again.
3. Candidate: a measurement race in the spec: outsBefore is read at :141 once "before" is shown, but a focus report from the Shortcut sheet's close may reach the program after it.

Next: a RED that forces 2 or 3, then the fix, in this PR.
