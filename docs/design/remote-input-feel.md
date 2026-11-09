# Remote input feel and phone resume

Written 2026-11-08 against `dev` at `ca44b8a8`. Every line reference below is to that head; herdr-core references are to
`herdrdev/herdr-core` `main` as read the same day. Decisions are numbered D1-D10 so a review can cite one.

## 1. The premise

Round-trip time through the relay is accepted as it is. A phone in Korea reaches a host through a Cloudflare Durable
Object that is not in Korea, and that will not change without an enterprise plan, so nothing here chases raw RTT
(`docs/architecture.md:101-125` has the measured figures). What this design changes is what a person **feels** at that RTT:

1. A keystroke should appear the moment it is typed, not one round trip later.
2. Coming back to the app should show the terminal as it is now, in one step, not a fast-forward of everything that
   happened while the app was away.
3. Nothing typed while the app is waking up may be lost.

The model for (1) is mosh's predictive local echo. The model for (2) is "latest screen, one paint". (3) is a defect found
while reading the wake path; it becomes visible the moment (1) exists, because a prediction that never confirms is how a
lost keystroke would look.

## 2. What the code does today

### Input

- Everything typed goes through one function: `send` in `apps/web/src/terminal/use-terminal-input.ts:37-42`. It writes
  to the open stream and, when the write returns false (no stream), queues the input in `pending` for the next stream.
  Keys from the renderer arrive through `typedInto` (`:43-46`, after `transformInput`, which is how a latched phone
  modifier rewrites `c` into `^C`), keys from the phone key bar and bound keys through `typed` (`:49-60`), which first
  sends any syllable still composing (`takeComposition`).
- `TerminalStream.write` (`packages/client/src/terminal-stream.ts:98-106`, `:191-199`) frames the bytes and hands them to
  the wire; `Wire.sendBytes` (`packages/client/src/wire.ts:81-88`) throws only when the wire already knows it is closed;
  the WebSocket link sends whenever `readyState === OPEN` and otherwise drops silently
  (`apps/web/src/connection/ws-link.ts:75-77`). There is no acknowledgement of input anywhere in the protocol: DATA
  frames carry no sequence number, and CREDIT (`packages/protocol/src/frame.ts:19`, `:54-58`) counts output only.
- An IME composition is already drawn locally: `apps/web/src/terminal/use-preedit.ts:28-113` places a `.term-preedit`
  row over the grid at `bridge.getCursor()`, underlined, and re-places it when the grid changes. This is the only piece
  of "local echo" the app has, and it is the shape the prediction overlay copies.

### Output

- Output is paced to paints: `OutputPacer` (`apps/web/src/terminal/output-pacer.ts:41-137`) queues bytes and writes at
  most `FRAME_BYTES = 16 KiB` per animation frame (`:4`, `:112-136`), returning the stream's credit only once bytes are
  written (`:135`, `terminal-view.tsx:110-119`). The core's initial window is 256 KiB
  (`herdr-core crates/herdr-core/src/wire.rs:26`), so the program is throttled to what the page draws (#560).
- Inside a synchronized update (DECSET 2026) the pacer writes unpaced for up to `SYNCHRONIZED_UNPACED_MS = 1000`
  (`:10`, `:96-99`), because wterm holds its paint for that long (`@wterm/dom` `SYNCHRONIZED_OUTPUT_TIMEOUT_MS = 1000`).
- Visibility is intersection-based only: `use-pane-visibility.ts:11-27` calls `pacer.setVisible` and
  `wt.setRenderingPaused` from an `IntersectionObserver`. A hidden **document** (phone in the background) never changes
  intersection; what stops the pacer there is that `requestAnimationFrame` stops firing.

### Wake

- `resumeOnWake` (`apps/web/src/connection/wake.ts:46-53`) turns `online`, `pageshow` and `visibilitychange -> visible`
  into `store.retryNow()`. With an open connection that probes it: one `terminal.list` with a fixed 10 s deadline
  (`store.ts:64`, `:381-389`, `:411-429`); no answer closes the link and the normal reconnect runs.
- During those up to 10 s the stream still reports `open`, so `send` writes into a socket that may be half-open and the
  bytes are gone (`ws-link.ts:75-77`). This is the lost-keystroke path; #1370 reports the 10 s from the other side.

### Reattach

- A reconnect re-attaches with `history: 2000` and `resumed: true` (`apps/web/src/terminal/opening-attach.ts:14`,
  `use-terminal-attach.ts:158-165`). Before the replay it drops the pacer queue, resets the image transcoder, writes RIS
  (`FULL_RESET`, `:20`, `:185-188`) so the local scrollback is wiped, and arms a hold at the end (`:190-191`,
  `hold-view-at-end.ts:20-44`, #1040; #1393/#1394 are reworking which readers it holds).
- The core's first paint is one `data()` call (`viewers.rs:95-110`) built by `ghostty-vt`'s `paint()`
  (`crates/ghostty-vt/src/lib.rs:704-740`): a soft reset that **ends** any synchronized update (`ESC[?2026l`), home +
  clear, the history lines pushed up into scrollback, home + clear again, the active screen, an optional title. The wire
  chunks it into 16 KiB frames under the 256 KiB credit window (`wire.rs:303`), so several hundred KiB arrive in
  window-sized slices one round trip apart. There is no end marker; #812 measured that a client-side "unpaced until
  quiet" rule cannot find the end reliably under load.

### What a backlog does while the app is away

- The core keeps up to `MAX_PENDING = 4 MiB` of output for a viewer that stopped crediting (`wire.rs:28`); past that it
  clears the backlog and sends a screen-only repaint (`wire.rs:239-252`, `viewers.rs:164-176`). So the program is never
  blocked by a sleeping phone, and the client can never be handed more than ~4.25 MiB of stale bytes on return.
- Those bytes return at the window rate: 256 KiB per round trip (credit is returned on write), paced on screen at 16 KiB
  per frame. A 4 MiB backlog is 16 round trips of arrival and ~256 frames of fast-forward. That, and the paced history
  replay after a reconnect, are the "빠른재생으로 와다닥" Q reports.

## 3. Decisions

### D1. Predictions live in an overlay and never enter the terminal model

Chosen: a `.term-prediction` layer drawn over the grid, as `use-preedit.ts` draws the composition. Predicted cells are
underlined glyphs at (row, col) with a predicted cursor; the real cursor is hidden while a prediction is shown. The VT
(libghostty) holds only what the host sent, so validation is a read of `bridge.getCell(row, col)` and
`bridge.getCursor()` after each write (both synchronous in `@wterm/ghostty 0.5.9`: `writeRaw` is one wasm call).

Rejected: writing the predicted byte into the VT and undoing it when the echo arrives (xterm.js "local echo" addons).
libghostty cannot rewind, the host's bytes interleave with the local write at an advanced cursor, and a wrapped or wide
cell corrupts the row. The overlay costs a DOM layer per view and a geometry helper; the write-through costs correctness.

### D2. Confirmation is by screen content with a time bound, not by an input acknowledgement

mosh confirms a prediction against a server frame it knows was computed after the keystroke. We have no such ack (§2).
Chosen: a prediction is **confirmed** when the real cell at its position shows its text; it is **killed** (and every
prediction of its epoch with it) when the cell shows something else after `due` has passed, when the real cursor leaves
the anchored row, when `due` passes with no echo at all, or when the view is reset or re-attached.
`due = clamp(1.5 * SRTT + 120 ms, 200 ms, 1500 ms)`, where SRTT is the connection's measured call round trip (D7).

Trade-off: a program that echoes slowly (a TUI re-rendering under load) can be read as "did not echo", which kills the
epoch and hides predictions until the next confirmed echo. The cost is a brief disappear-and-reappear of one typed
character; the alternative, waiting indefinitely, is how a password prompt would show a password. The constants are
tunables with a measured basis required in the PR (echo latency over the e2e harness at an injected 250 ms RTT).

Deferred: a core-side input acknowledgement (sequence on DATA, "consumed up to" on output) would make confirmation exact.
It is a herdr-core protocol change (§5); the predictor takes its confirmation source behind one interface so an ack can
replace the timer later.

### D3. Epochs: nothing is shown until one prediction has been confirmed

mosh's rule, kept exactly. Predictions carry the epoch they were made in; they are drawn only while
`epoch === confirmedEpoch`. A kill increments `epoch`, so what follows is predicted silently ("tentative") until the
host echoes one of them, which sets `confirmedEpoch`. On attach the epoch is unconfirmed: the first keystroke in a fresh
terminal is never shown before its echo.

Consequence at a password prompt (the case the suppression rules exist for): the person was typing a command (epoch
confirmed), presses Enter, the prompt asks for a password, they type the first character. That character is predicted
and **shown for at most `due`** (about 500 ms over the relay), then killed because nothing echoed; every later character
is tentative and never shown. This is the same residual mosh has, on the person's own screen. Rejected alternatives:
sniffing prompt text (brittle, language-dependent, wrong for every non-shell program); never predicting the first
character after Enter (removes the win for the most common keystroke pattern: type, Enter, type). The exact fix is the
core reporting the pty's ECHO flag (§5).

### D4. What is never predicted

The rule set is closed; a case not listed is not predicted. Each line is one row of the predictor's spec table.

| # | Input or state | Prediction | Why |
|---|---|---|---|
| P1 | Anything but exactly one grapheme of printable text (C0, DEL, ESC-led sequences, multi-character strings) | none | control keys and encoded keys (kitty `CSI u`, arrows, Enter, Tab) are the program's to interpret; a paste is many characters |
| P2 | Input from a paste (`PasteDialog`, `TerminalPort.paste`, renderer paste) | none | even a one-character paste is tagged `paste` at the call site, never inferred from length |
| P3 | `bridge.usingAltScreen()` true | none | full-screen programs (vim normal mode, less, pickers) treat letters as commands; the win is on the main screen where Q's agents run |
| P4 | Cursor within `width` cells of the right margin (`col + width > cols - 1`) | none | mosh does not predict a wrap either; the shell's wrap and the terminal's differ |
| P5 | An IME composition in progress | none | the preedit overlay already shows it; the committed syllable is then predicted as a 2-cell glyph (P7) |
| P6 | No open stream, link unproven after a wake (D6), or `pending` non-empty | none | queued input would show as a long phantom; it is sent in order when the stream is back, and the echo draws it |
| P7 | A grapheme of width 2 (Hangul syllable, CJK) | 2 cells, if P4 allows | width from the existing `CodepointWidths`; a multi-codepoint grapheme (emoji ZWJ) is not predicted |
| P8 | Backspace (`0x7f`/`0x08` as sent) | pops the last unconfirmed prediction when the predicted cursor sits right after it; otherwise P1 | erasing real text is the program's business (readline, wide cells) |
| P9 | After any unpredicted input (P1) | no new predictions until the next host write re-syncs the cursor | the cursor is unknown after Enter, an arrow or a chord; existing predictions stay until confirmed or due |
| P10 | Bytes from `writeAutomatic` (query answers) | none | never human typing |
| P11 | The view is scrolled away from the end | overlay hidden, predictions kept | the overlay anchors to active-screen rows; wterm scrolls to the end on the next key anyway |
| P12 | `observe: true` streams | n/a | they never type |

Adaptive display (D8) is a separate gate over the whole table.

### D5. A returning person sees the latest screen in one step; the client drops nothing

Two mechanisms, two fixes, one rule.

**Backlog with the socket alive (the app was in the background, the link survived).** The queue is bounded by
construction (§2: 256 KiB in the pacer plus at most 4 MiB pending in the core). Chosen: a **catch-up** rule in the pacer
that is depth-based, not boundary-based. When the queue holds more than `CATCHUP_THRESHOLD` bytes, a frame writes the
whole queue (bounded by `CATCHUP_FRAME_BYTES`, a number the slice measures on the render bench under 4x CPU throttle so
one frame's write stays under ~50 ms), and wterm paints once. While the document is hidden the pacer drains on a timer
(not rAF) with rendering paused, so the VT stays current and credit keeps flowing for as long as the platform lets the
page run; the backlog waiting at return is then smaller or empty.

Residual, stated: bytes still arrive at 256 KiB per round trip, so a large backlog appears as a few snapshots one RTT
apart (16 for the 4 MiB maximum over a 250 ms relay), not as a scroll show. The client does not try to tell the tail of
the backlog from live output; #812 showed that guess cannot be made reliably. The core's own >4 MiB repaint stays the
one place stale output is dropped, and it is the core's decision.

Rejected: granting extra credit at wake to pull the backlog faster. Credit after write is the single flow-control knob
(#560, `docs/architecture.md:138`); widening it on a phone trades the screen's responsiveness and memory for a gain that
RTT bounds anyway. Rejected: a quiet-window to end "stale" and start pacing again — it is the #812 heuristic.

**Replay after a reconnect or a fresh mount (#812, #1040, #1363, #1393).** Chosen: a **replay mode** in the pacer,
entered on every attach's first paint: writes are unpaced (as inside a synchronized update) with `setRenderingPaused`
held, and the mode ends at the first of: quiet for `max(100 ms, 1.5 * SRTT + 50 ms)` since the last DATA frame, a cap of
1500 ms, or `MAX_REPLAY_BYTES`. Then rendering resumes and the end-hold runs once. The person keeps seeing the old screen
until the new one is ready; no blank, no history climbing past them.

Trade-off: this is still a client guess at the boundary, improved by making the quiet window relative to the measured
RTT (the slices arrive exactly one RTT apart because credit returns on write) instead of a fixed 150 ms. Its failure
mode is benign and bounded: a tail of the replay gets paced, a shorter version of today. It can never be worse than
today. The exact fix is the core bracketing its first paint in `ESC[?2026h … ESC[?2026l` (#812's proposal, §5); the
pacer already honours such a bracket (`output-pacer.ts:36-39`), so when that lands the replay mode becomes redundant
without a client change.

Rejected: re-attaching with `history: 0` and keeping the local scrollback. The screen alone fits one frame, but every
reconnect would leave a hole in the scrollback exactly where the person wants to read what happened while they were
away. Scrollback older than 2000 lines is already dropped on every reconnect today (`FULL_RESET` + `HISTORY_LINES`);
that drop is kept and named here, and its real fix is a resume by offset (C2 in #653, D13 in `docs/architecture.md:290`).

### D6. Input typed while the link is unproven is held, in order, never written into a possibly dead socket

Chosen: the store exposes "a wake probe is pending" on its open state; `send` queues into `pending` while it is, and the
queue flushes to the same stream in order the moment the probe answers (any answer proves the link). If the probe times
out, the link closes and `pending` reaches the new stream through the path that exists today
(`use-terminal-attach.ts:210`). Cost: typing delay of one round trip after each return to the app.

Rejected: writing immediately and keeping a copy to re-send after a reattach. When the socket was in fact alive the
keystroke is delivered twice; a doubled Enter is a doubled command.

The probe deadline becomes adaptive: `clamp(4 * SRTT + 500 ms, 1500 ms, 10 000 ms)`, 10 s when no sample exists. This is
#1370's ask ("reconnect within about a second of returning") with a floor that keeps a slow but live relay link from being
dropped into a replay.

### D7. One RTT estimator on the connection

`HcConnection` keeps SRTT/RTTVAR (TCP-style EWMA, alpha 1/8) from every channel-0 call that gets an answer; a timed-out
or aborted call does not feed it. The attach call itself is the first sample. Consumers: the predictor's `due` and
display gate, the wake probe deadline, the replay quiet window. One number, measured where the bytes travel, instead of
three guesses.

### D8. Predictions are shown adaptively, with underline, and can be turned off

Default `adaptive`: predictions are drawn only when `SRTT >= 60 ms`; on a loopback or LAN link they bring nothing and
could only glitch. `always` and `off` are offered in Settings. Underline is always on when a prediction is drawn: the
underline **is** the "unconfirmed" signal, as mosh's. This is a settings row with a clear default and removes no
capability, so it ships without a product decision.

### D9. Nothing here depends on herdr-core landing anything

Two upstream asks are filed (§5) because they are the exact fixes. Every slice in the plan is specified so that it is
correct and merged without them, and so that landing them later makes a client mechanism redundant rather than wrong.

### D10. Bytes and their order are never changed by the client

The client's role on the output path stays what the passthrough rule says (`docs/architecture.md:91`): the pacer decides
**when** bytes reach the VT, never what they are. Replay mode and catch-up only change timing and the paint hold. The
only local bytes written remain the ones written today (`FULL_RESET`, the cursor-style sequence).

## 4. Residuals a reviewer should know

- The first character typed at a prompt that does not echo can be visible, underlined, for up to `due` (D3).
- A large backlog returns as snapshots one RTT apart, not instantly (D5).
- Scrollback older than 2000 lines is lost on a reconnect (today's behaviour, kept; D5).
- Replay mode's end is a bound, not a marker (D5); a tail may be paced.
- One round trip of typing delay after returning to the app (D6).

## 5. Asks to herdr-core (filed, not gates)

1. Bracket the attach first paint in `ESC[?2026h … ESC[?2026l` instead of starting with `ESC[?2026l` (#812's proposal;
   `crates/ghostty-vt/src/lib.rs:710`). Makes D5's replay mode redundant.
2. Report the pty's ECHO flag (termios) as a viewer-visible fact (a `Terminal` field or a stream frame), so a client can
   suppress prediction exactly where the program does not echo. Makes D3's residual zero.
3. Later: an input sequence on DATA and a "consumed up to" on output, for exact confirmation (D2).

## 6. What we do not do

- No per-key writes into the terminal model, in any form.
- No prompt-text or program-name heuristics for password prompts.
- No change to `HISTORY_LINES`, `FULL_RESET`, or the credit-after-write rule.
- No extra credit granted at wake; no client-side drop of stale bytes.
- No re-send of input that was already written.
- No fixed quiet windows shorter than the SRTT-relative floor; no sleeps in specs.
- No wterm patch for the overlay; public bridge APIs only (`getCell`, `getCursor`, `usingAltScreen`, `getCols`).
- No merge gated on herdr-core.
