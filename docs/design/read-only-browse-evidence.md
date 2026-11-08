# Read-only browsing and shift-drag: RED and GREEN

Recorded 2026-11-08 on a macOS arm64 host with Playwright 1.64.1 and Chromium, for [read-only-browse.md](read-only-browse.md).

## Commands

From `apps/web`, with the same three specs every time:

```bash
bunx playwright test e2e/terminal-shift-drag.e2e.ts e2e/phone-browse-mode.e2e.ts e2e/phone-browse-guards.e2e.ts --workers=2 --reporter=line
```

- GREEN ran on the branch at `3b785e97`.
- RED ran with every production file the branch changes (`apps/web/src/**` and
  `packages/ui/src/components/extra-keys-bar.tsx`) checked out from the base `af2a48e8`, or deleted where the base
  lacks it, and with the specs unchanged. The tree was restored afterwards (`git checkout HEAD -- apps/web/src
  packages/ui/src`).

## RED: base production files (exit 1)

```
  8 failed
    [chromium] › e2e/phone-browse-guards.e2e.ts:13:1 › the terminal pans and pinch-zooms only, while the rest of the page keeps the base's manipulation
    [chromium] › e2e/phone-browse-guards.e2e.ts:23:1 › browsing read-only, a wheel over the rows reaches nothing the program reads
    [chromium] › e2e/phone-browse-guards.e2e.ts:46:1 › browsing read-only ends when another terminal is opened
    [chromium] › e2e/phone-browse-mode.e2e.ts:30:1 › browsing read-only, a tap reaches neither the program nor the keyboard; leaving it, a tap does again
    [chromium] › e2e/phone-browse-mode.e2e.ts:65:1 › browsing read-only, a held finger and a drag select, and the menu offers Copy without Paste
    [chromium] › e2e/phone-browse-mode.e2e.ts:95:1 › browsing read-only, a swipe scrolls the scrollback and the program hears nothing
    [chromium] › e2e/terminal-shift-drag.e2e.ts:30:1 › with mouse tracking off, a plain drag and a Shift drag each select and copy on select
    [chromium] › e2e/terminal-shift-drag.e2e.ts:63:1 › under a program that tracks the mouse, Shift and a drag select the text and the program hears nothing
  1 passed (5.0m)
```

The first error of each failure:

- touch-action: `Expected: "pan-y pinch-zoom"  Received: "auto"`.
- The five phone browse cases: `locator.click: Test timeout of 60000ms exceeded … waiting for getByRole('button', { name: 'Read-only', exact: true })`, because the base has no browse mode.
- Both shift-drag cases (tracking off and tracking on): `expect(received).toBeGreaterThan(expected)  Expected: > 0  Received: 0`, because no cells are painted.
- The case that passes is the guard "under a program that tracks the mouse, a plain drag is reported to it and selects nothing". That was already the base's behaviour, and it must keep passing.

The RED run used the touch-action case as it stood before that case was split in two. On the base, the terminal half fails on its own (`auto`).

## GREEN: the branch (exit 1, with one failure that is the #1382 dependency)

```
  1 failed
    [chromium] › e2e/phone-browse-guards.e2e.ts:13:1 › the terminal pans and pinch-zooms only, while the rest of the page keeps the base's manipulation
  8 passed (2.3m)
```

That failure was `Expected: "manipulation"  Received: "auto"` on the page banner: #1382's base rule is not on this
branch's base. The case was then split. Re-run of `e2e/phone-browse-guards.e2e.ts` at the split:

```
  1 skipped
  3 passed (2.0m)
```

- **Proven now:** the terminal computes `pan-y pinch-zoom`. That case is unconditional and passes.
- **Pending #1382:** the rest of the page computes `manipulation`. The case skips with the reason "pending #1382: the
  base's * { touch-action: manipulation } is not on this branch's base yet", and the pair completes when #1382 lands.

## WebKit: desktop shift-drag, run once

```bash
E2E_BROWSERS=all bunx playwright test e2e/terminal-shift-drag.e2e.ts --project=webkit --workers=1 --reporter=line
```

```
    Error: browserContext.newPage: Unknown permission: clipboard-write
  3 failed
```

WebKit cannot run this spec as written: Playwright's WebKit rejects the `clipboard-write` permission the spec grants,
before any page opens. The shift-drag behaviour under WebKit is therefore **unverified**, and so is every phone case
on iOS Safari (see "Choices and known limits" in the design doc).
