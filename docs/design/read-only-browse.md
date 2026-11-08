# Read-only browsing and shift-drag selection

Written 2026-11-08 for the phone's read-only browse mode and the shift-drag fix that shipped with it. Both sit on the
same fact: a terminal view has two consumers of a pointer, the program (mouse reports, through `@wterm/dom`'s
`InputHandler`) and the person (selection and scrolling), and the view decides which one a gesture belongs to.

## The two defects

**On a phone, every touch reaches the program.** A tap on the terminal is turned by the browser into `mousedown`,
`mouseup` and `click`; wterm answers them by focusing its hidden textarea (the soft keyboard comes up) and, when the
program tracks the mouse (`?1002h`/`?1003h`, as agent TUIs do), by writing a press and a release report to the PTY.
Reading a long answer on the phone therefore means clicking inside the agent's UI by accident and fighting the
keyboard.

**With a mouse, Shift+drag never selected.** Measured on `@wterm/dom` 0.5.9 under `?1003h` with Playwright: a plain
drag reports press, motion and release to the program; a shift-drag reports nothing (wterm already bails on a shift
press before `preventDefault`), but it also selects nothing: the document selection stays empty and no cells are
painted, while focus goes textarea -> body -> textarea. The cause is the browser's own Shift+mousedown semantic: shift
_extends the existing selection_, and the existing selection is the caret inside wterm's focused textarea. A selection
cannot extend from an editable caret into the non-editable rows, so Chromium makes none. Tracking is irrelevant to this;
it only removes the plain drag as a way out.

## Designs considered

### A. App-side gate and app-owned gestures (chosen)

- `terminal/browse-mode.ts`: while a view is browsing, a capture-phase listener on the terminal element stops
  `mousedown`, `mousemove`, `mouseup`, `click`, `dblclick`, `auxclick` and `wheel` before wterm's own listeners (all of
  which sit on the same element in the bubble phase, or on the textarea below it), marks the element
  `data-browsing="true"`, and blurs the textarea so the keyboard goes down. CSS gives the textarea `pointer-events:
  none` while browsing, so a press lands on the rows and the browser moves focus nowhere that raises a keyboard.
  `mayTakeFocus` answers false for a browsing terminal, so nothing in the app (a pane becoming focused, a press ending,
  a menu closing) hands the keyboard back until browsing ends. Pointer events are untouched: the held-press selection
  (`use-long-press-select.ts`, #664) and the browser's own one-finger scroll keep working, and a tap on a link still
  offers Open and Copy (`terminal-links.tsx` registers its capture listener first).
- `terminal/use-shift-drag-select.ts`: a shift press with the primary button is the view's gesture, not the browser's.
  The press is cancelled (so the browser never tries to extend the textarea's caret, and the textarea keeps focus and
  the keyboard), and the drag builds a range from the press caret to the pointer with `caretAt` and holds it
  (`held-selection.ts`), the same range the long press holds: painted as whole cells (#410), copied by the copy handlers
  and the chord, and never a document selection, so the input method keeps composing Hangul (#592).

Trade-offs: the gate depends on listener order only where it matters for links (a capture listener registered earlier
on the same element still runs), and on wterm keeping its mouse listeners on the element rather than on the window;
both are facts about 0.5.9 that an upgrade would show at once in the phone spec. Shift+click on its own extends
nothing (the press at the document's capture phase already dropped the previous held range), which Ghostty does differ
on. No fork grows: the `@wterm/dom` patch is unchanged.

### B. A read-only switch inside the patched `@wterm/dom`

`InputHandler.setReadOnly(on)` returning early from `handleKeyDown`, `handleMouse`, `_onInput` and `_onPaste`, and
`WTerm._onClickFocus` skipping its focus. One switch where the listeners live, immune to ordering. Rejected: the patch
is already ~800 lines of `dist/*.js` that every wterm upgrade re-applies by hand and that no unit test in this
repository exercises; the app would still own the focus gate, the UI and the Paste item; and the shift-drag defect is
not wterm's to fix (the browser's extend semantic happens before any wterm code runs), so the package would gain a
switch and the app would still need the gesture.

## What the person sees

- Keyboard down, on a touch device: a round **Browse output** button sits beside the round keyboard button. Tapping it
  puts the terminal in read-only browsing: the keyboard button goes, the browse button reads pressed, and a chip at the
  top of the terminal says `Read-only`. A mouse-only window (no soft keyboard, #287) never shows the button: shift-drag
  is its way to select under a tracking program.
- While browsing: one finger scrolls the scrollback, a held finger selects the word under it and a drag from there
  takes what it reaches, lifting offers **Copy** (Paste is not offered: nothing is written). A tap does nothing to the
  program and raises no keyboard. The key bar and the header mic stay away: there is nothing to type into.
- Tapping the pressed button ends browsing. Switching to another terminal ends it too; a terminal that ended or an
  offline machine has nothing to browse read-only, so the control is not shown there.

Scope stays the screen: a bound key from a hardware keyboard that sends bytes (`send:` actions) is a deliberate act and
is not gated by browsing.

## Proof

- `e2e/phone-browse-mode.e2e.ts` (iPhone 14 viewport, touch through CDP): under `?1003h` a tap before browsing reaches
  the program as a report; in browsing the same tap reaches nothing, the textarea is not focused and no key bar is
  shown; a held finger and drag select and Copy; a swipe scrolls; leaving browsing, a tap reaches the program again.
- `e2e/terminal-shift-drag.e2e.ts` (desktop): under `?1003h` a plain drag is reported to the program; a shift-drag
  reports nothing, selects the dragged text as painted cells and keeps the textarea focused.
