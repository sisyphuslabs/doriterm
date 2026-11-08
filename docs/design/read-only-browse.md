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
  `mousedown`, `mousemove`, `mouseup`, `click`, `dblclick`, `auxclick` and `wheel` before wterm's own input
  listeners, marks the element
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

The invariant the gate rests on, and the one a wterm upgrade is checked against: **every wterm handler that writes to
the PTY or focuses the textarea is bubble-phase on the terminal element, or on `window` only after a reported press.**
In 0.5.9 the PTY-writing and focusing handlers are bubble listeners on the element (`input.js` `handleMouse`,
`wterm.js` `_onMouseSelect` and `_onClickFocus`), and its window `mousemove`/`mouseup` are attached only after a
reported press, which the gate never lets through. wterm also registers capture listeners (`rectangle-drag.js`
`mousedown` and `click` on the element, a webgl `mousedown`, a document `pointerdown` in `history-selection.js`);
they are Alt-only or read-only, write nothing and focus nothing, so they sit outside the invariant.

Trade-offs: the gate depends on listener order only where it matters for links (a capture listener registered earlier
on the same element still runs). Shift+click on its own extends nothing (the press at the document's capture phase
already dropped the previous held range), where xterm and Ghostty extend. A shift double or triple click is cancelled
before wterm's word or line select (`use-shift-drag-select.ts`), so it never adds a native selection beside the held
one. No fork grows: the `@wterm/dom` patch is unchanged.

### B. A read-only switch inside the patched `@wterm/dom`

`InputHandler.setReadOnly(on)` returning early from `handleKeyDown`, `handleMouse`, `_onInput` and `_onPaste`, and
`WTerm._onClickFocus` skipping its focus. One switch where the listeners live, immune to ordering. Rejected: the patch
is already ~800 lines of `dist/*.js` that every wterm upgrade re-applies by hand and that no unit test in this
repository exercises; the app would still own the focus gate, the UI and the Paste item; and the shift-drag defect is
not wterm's to fix (the browser's extend semantic happens before any wterm code runs), so the package would gain a
switch and the app would still need the gesture.

## What the person sees

- Keyboard down, on a touch device: a round **Read-only** button sits beside the round keyboard button. Tapping it
  puts the terminal in read-only browsing: the keyboard button goes, the browse button reads pressed, and a chip at the
  top of the terminal says `Read-only`. A mouse-only window (no soft keyboard, #287) never shows the button: shift-drag
  is its way to select under a tracking program.
- While browsing: one finger scrolls the scrollback, a held finger selects the word under it and a drag from there
  takes what it reaches, lifting offers **Copy** (Paste is not offered: nothing is written). A tap does nothing to the
  program and raises no keyboard. The key bar and the header mic stay away: there is nothing to type into.
- Tapping the pressed button ends browsing. Opening another terminal ends it too. A terminal that ended or an
  offline machine has nothing to browse read-only, so the control is not shown there.
- One accessible name for the mode: the button and the chip both say **Read-only**.

Scope stays the screen: a bound key from a hardware keyboard that sends bytes (`send:` actions) is a deliberate act and
is not gated by browsing.

## Choices and known limits

- **Offline keeps the mode.** `browsingOn` is kept while a machine goes offline and resumes when it returns
  (`phone-terminal.tsx`), so a reconnect never hands the keyboard back to someone who chose read-only. The mode is
  per-terminal and not persisted: a reload starts interactive. Both are choices, and neither has a spec.
- **Screen readers.** The `Read-only` chip is a `role="status"` that mounts with its text, which not every screen reader
  announces; a persistent live region whose text changes would be. Browsing blurs the textarea, so wterm's output
  announcements (reset on focusin and focusout) stop while browsing, and a reader reads the rows with the virtual
  cursor. Both are accepted for v1 and unverified with a real screen reader.
- **No auto-scroll** while a shift-drag passes the viewport edge (xterm scrolls); the range follows the pointer only.
- **Copy on select after a shift-drag** listens for `mouseup` on the terminal element (`use-behaviors.ts`), so a drag
  released outside the terminal copies nothing. That is the existing handler's limit, and it now covers the held range.
- **State on the DOM.** `isBrowsing()` reads `data-browsing` from the element because `mayTakeFocus(element)` takes an
  element, so part of the mode's state lives outside React.
- **Not proven by a spec:** that a mouse-only window never shows the button, that an ended or offline terminal hides
  it, and that a link tap while browsing still offers Open and Copy. They follow from the code as read.
- **Phone proof is Chromium only.** Touch is driven through CDP `Input.dispatchTouchEvent`, which only Chromium has.
  iOS Safari is **unverified**: its long-press callout against the app's held press, `navigator.clipboard.writeText`
  from the menu, and rubber-band scroll at the scrollback's ends. The desktop shift-drag spec was run once under
  WebKit, and the result is in the evidence file.

## Landing order with #1376 and #1382

- **#1376** (`fix/1375-phone-keyboard-press`) edits the same `TerminalViewProps` block this branch moves to
  `terminal-view-props.ts` (the move is its own commit, "refactor(web): move TerminalView's props out of the view
  file"), the same `<TerminalView>` props in `phone-terminal.tsx`, and `terminal-port.ts`, so the textual conflict is
  certain. #1376 lands first, and this branch rebases onto it and carries its props into the new file. The semantics
  compose: #1376's `useKeyboardClaim` still asks `mayTakeFocus`, so a browsing terminal is never claimed. After the
  rebase `openPhoneTerminal` presses "Show keyboard" before it returns, so the Read-only button shows only once the
  field is blurred; every phone spec here blurs the field and then asserts the button before clicking it.
- **#1382** (`fix/1380-phone-zoom`) adds `* { touch-action: manipulation }` to the base. Browse mode relies on the
  one-finger pan that rule keeps, and the held-press drag cancels `touchmove` itself once it has picked. The terminal
  keeps the more specific `touch-action: pan-y pinch-zoom` (`styles.css`), and #1382 is not edited (LEAD ruling).
  `e2e/phone-browse-guards.e2e.ts` asserts both computed values, so its first case stays red until #1382 is on the
  base; #1382 therefore lands before this branch.

## Proof

- `e2e/phone-browse-mode.e2e.ts` (iPhone 14 viewport, touch through CDP): under `?1003h` a tap before browsing reaches
  the program as a report; in browsing the same tap reaches nothing, the textarea is not focused and no key bar is
  shown; a held finger and drag select and Copy; a swipe scrolls; leaving browsing, a tap reaches the program again.
- `e2e/terminal-shift-drag.e2e.ts` (desktop): under `?1003h` a plain drag is reported to the program; a shift-drag
  reports nothing, selects the dragged text as painted cells, keeps the textarea focused and copies on select. With
  tracking off, a plain drag and a Shift drag each select and copy.
- `e2e/phone-browse-guards.e2e.ts` (iPhone 14 viewport): the touch-action pair; under `?1003h` a wheel over the rows
  while browsing reaches nothing; opening another terminal ends browsing.
- RED on the base and GREEN on this branch, with commands and output:
  [read-only-browse-evidence.md](read-only-browse-evidence.md).
