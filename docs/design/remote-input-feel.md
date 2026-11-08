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
  replay after a reconnect, are the fast-forward people report on returning to the app.

## 3. Decisions

### D1. Predictions live in an overlay and never enter the terminal model

Chosen: a `.term-prediction` layer drawn over the grid, as `use-preedit.ts` draws the composition. Predicted cells are
underlined glyphs at (row, col) with a predicted cursor; the real cursor is hidden while a prediction is shown. The VT
(libghostty) holds only what the host sent, so validation is a read of `bridge.getCell(row, col)` and
`bridge.getCursor()` after each write (both synchronous in `@wterm/ghostty 0.5.9`: `writeRaw` is one wasm call).

Rejected: writing the predicted byte into the VT and undoing it when the echo arrives (xterm.js "local echo" addons).
libghostty cannot rewind, the host's bytes interleave with the local write at an advanced cursor, and a wrapped or wide
cell corrupts the row. The overlay costs a DOM layer per view and a geometry helper; the write-through costs correctness.

### D2. Confirmation is by screen content; only a causal ack or expiry judges a prediction wrong

mosh judges a prediction only once the server has acknowledged the frame that carried its key: until
`late_ack >= expiration_frame` a cell is `Pending` whatever the screen shows (`terminaloverlay.cc:86-90`). We have no
such ack (§2), and the substitute must keep that property: a late echo means "not yet known", never "wrong".

Chosen: a prediction is **confirmed** when the real cell at its position shows its text. A match that proves no echo (a
blank, or a cell that already showed the same glyph before the key: mosh's `CorrectNoCredit`, `terminaloverlay.cc:91-109`)
confirms nothing and stays pending, holding the predicted cursor, until it is answered or expires. A prediction is
**incorrect** only on a **causal ack**: a key sent after it has been confirmed (in the same write or an earlier one), so
the program, which answers keys in order, has answered this one too, and its cell still does not show it. Otherwise it
only **expires**, at RFC 6298's retransmission timeout over the predictor's echo round trip (D7):
`max(1000 ms, SRTT + 4 * RTTVAR)`, the RFC's one-second floor included. Time alone never produces "incorrect". An
incorrect or expired prediction that was drawn resets everything (mosh `reset()`); one that was not drawn kills only its
epoch and later ones (mosh `kill_epoch`), which hides nothing. The alternate screen turning on, or `reset()` on
attach, drops everything; tentative predictions on a row the cursor has left are dropped (nothing drawn goes with them).

**Correction (2026-11-08, #1439 HIGH 1).** The first version killed a prediction whose cell showed something else once
`due = clamp(1.5 * SRTT + 120 ms, 200 ms, 1500 ms)` had passed, and killed every prediction when the cursor left the
anchored row. Both are judgements made on time or screen state with no ack, which mosh never makes; on a relay whose
echo spread (270-400 ms) exceeds the typing interval (70 ms), a time-judged "incorrect" in a confirmed epoch makes every
drawn character vanish and the next key invisible for a round trip. The constants were also chosen, not derived. What
replaced them is above; the proof is a 200-key run under an order-preserving 270-400 ms jitter with zero resets
(`prediction-jitter.test.ts`), and the same run with a time-judged "incorrect" injected records 33 judgements.

Trade-off: a key the program never echoes, typed in a confirmed epoch without an Enter before it, stays drawn up to the
expiry (at least one second) before it goes; an Enter before it makes it silent instead (D3).

Deferred: a core-side input acknowledgement (sequence on DATA, "consumed up to" on output) would make confirmation exact.
It is a herdr-core protocol change (§5); the predictor takes its confirmation source behind one interface so an ack can
replace the timer later.

### D3. Epochs: nothing is shown until one prediction has been confirmed

mosh's rule. Predictions carry the epoch they were made in, and a prediction is drawn only once its epoch is confirmed
(`prediction.epoch <= confirmedEpoch`). A kill increments `epoch` and drops every prediction, so what follows is
predicted silently ("tentative") until the host echoes one of them, which sets `confirmedEpoch`. A submitted line (CR or
LF in the input, kitty-encoded Enter, a pasted line) also increments `epoch`, but keeps what was predicted before it:
those keys stay drawn until their own echo, and that echo does not confirm the keys after the Enter. On attach the
epoch is unconfirmed: the first keystroke in a fresh terminal is never shown before its echo.

**Correction (2026-11-08, #1430). This section first said something false about mosh, and the code does not follow
it.** The first draft did not start an epoch on Enter. At a password prompt (the case the suppression rules exist for)
the person types a command (epoch confirmed), presses Enter, the prompt asks for a password, and they type the first
character; the draft predicted that character and **showed it for up to `due`** (about 500 ms over the relay) before
killing it, and called that "the same residual mosh has". It is not mosh's residual: mosh calls `become_tentative()` on
CR (`src/frontend/terminaloverlay.cc:798-799`), so the first character after Enter is never drawn before its echo, and
mosh never flashes a password character. We now do what mosh does. The cost is the one the draft wanted to avoid: on
type, Enter, type, the first key after Enter is no longer drawn before its echo, a missing nicety on the most common
keystroke pattern. The alternative was a credential character on screen, and that is not a trade we make.

The residual now: the first key of every epoch is predicted silently and appears only with its echo (after a fresh
attach, after any kill, and after every submitted line). Nothing typed after Enter is drawn before the host has echoed
something in that epoch, so a prompt that does not echo shows nothing. Rejected alternatives, unchanged: sniffing prompt
text (brittle, language-dependent, wrong for every non-shell program). The exact fix for the lost nicety is the core
reporting the pty's ECHO flag (§5), which would let the first key after Enter be drawn wherever the program echoes.

### D4. What is never predicted

The rule set is closed; a case not listed is not predicted. Each line is one row of the predictor's spec table.

| #   | Input or state                                                                                            | Prediction                                                                                           | Why                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Anything but exactly one grapheme of printable text (C0, DEL, ESC-led sequences, multi-character strings) | none                                                                                                 | control keys and encoded keys (kitty `CSI u`, arrows, Enter, Tab) are the program's to interpret; a paste is many characters                                                                                                                 |
| P2  | Input from a paste (`PasteDialog`, `TerminalPort.paste`, renderer paste)                                  | none                                                                                                 | even a one-character paste is tagged `paste` at the call site, never inferred from length                                                                                                                                                    |
| P3  | `bridge.usingAltScreen()` true                                                                            | none                                                                                                 | full-screen programs (vim normal mode, less, pickers) treat letters as commands; the win is on the main screen where coding agents run                                                                                                       |
| P4  | Cursor within `width` cells of the right margin (`col + width > cols - 1`)                                | none                                                                                                 | the shell's wrap and the terminal's differ. (Correction, #1439: mosh does predict the last column and wraps its cursor tentatively, `terminaloverlay.cc:787-795`; this rule is stricter than mosh, see §4.)                                  |
| P5  | An IME composition in progress                                                                            | none                                                                                                 | the preedit overlay already shows it; the committed syllable is then predicted as a 2-cell glyph (P7)                                                                                                                                        |
| P6  | No open stream, link unproven after a wake (D6), or `pending` non-empty                                   | none                                                                                                 | queued input would show as a long phantom; it is sent in order when the stream is back, and the echo draws it                                                                                                                                |
| P7  | A grapheme of width 2 (Hangul syllable, CJK)                                                              | 2 cells, if P4 allows                                                                                | width from the existing `CodepointWidths`; a multi-codepoint grapheme (emoji ZWJ) is not predicted                                                                                                                                           |
| P8  | Backspace (`0x7f`/`0x08` as sent)                                                                         | pops the last unconfirmed prediction when the predicted cursor sits right after it; otherwise P1     | erasing real text is the program's business (readline, wide cells)                                                                                                                                                                           |
| P9  | After any unpredicted input (P1)                                                                          | a new epoch (mosh `become_tentative`): later keys are predicted silently until one of them is echoed | the cursor is unknown after Enter, an arrow or a chord; existing predictions stay until confirmed. Every refused input that reaches the program does this (P1-P7, P6 included since held input is sent later); P10 and P12 input never types |
| P10 | Bytes from `writeAutomatic` (query answers)                                                               | none                                                                                                 | never human typing                                                                                                                                                                                                                           |
| P11 | The view is scrolled away from the end                                                                    | overlay hidden, predictions kept                                                                     | the overlay anchors to active-screen rows; wterm scrolls to the end on the next key anyway                                                                                                                                                   |
| P12 | `observe: true` streams                                                                                   | n/a                                                                                                  | they never type                                                                                                                                                                                                                              |

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
or aborted call does not feed it. Consumers: the wake probe deadline and the replay quiet window.

**Correction (2026-11-08, #1439 HIGH 1).** The predictor does not read this estimator. Its expiry and display gate need
the round trip of an _echo_: keypress to the cell showing it, which includes the host's processing and the output
pacer's frame wait that a channel-0 call does not. And on a first attach the attach call was started with the run
(`takeOpeningAttach`, `opening-attach.ts`), so as a sample it measures anything from ~0 ms to more than a round trip. The
predictor therefore keeps its own RFC 6298 estimator over echoes, seeded by the first confirmation; nothing is drawn
before that confirmation anyway, so the seed costs nothing visible. Whether the connection's estimator should keep the
attach call as a sample is a question for its other two consumers, not for the predictor.

### D8. Predictions are shown adaptively, with underline, and can be turned off

Default `adaptive`, mosh's triggers ported with their derivation (`prediction-display.ts`). mosh compares its constants
(20/30 to show, 50/80 to underline) with `send_interval`, not SRTT, and `send_interval = ceil(SRTT / 2)` clamped to
[20, 250] (`transportsender-impl.h:61-68`, `stmclient.cc:305`). The port computes `sendInterval` the same way and keeps
mosh's constants, so in SRTT: drawn above 60 ms, stopped at 40 ms or less only while nothing is outstanding; underlined
above 160 ms, no longer at 100 ms or less. mosh's glitch trigger is kept too: a prediction outstanding 250 ms shows
predictions even on a fast link until ten quick confirmations at least 150 ms apart repair it, and one outstanding 5 s
underlines. The SRTT here is the predictor's echo round trip (D7), which carries the pacer's frame wait (+0-16.7 ms, ~8
on average) that mosh's transport SRTT does not, so a 10 ms LAN measures about 20-30 ms: still at or under the 40 ms
off threshold. `always` and `off` are offered in Settings. This is a settings row with a clear default and removes no
capability, so it ships without a product decision.

**Correction (2026-11-08, #1439 HIGH 2).** The first version drew predictions at `SRTT >= 60 ms` and underlined them
always. The 60 was mosh's 30 compared with SRTT through the wrong quantity, with no off threshold and no hysteresis, and
mosh underlines only on a slow link or a glitch (`flagging`), not always. Tested at every boundary, including SRTT 35,
which draws under the misport and must not.

### D9. Nothing here depends on herdr-core landing anything

Two upstream asks are filed (§5) because they are the exact fixes. Every slice in the plan is specified so that it is
correct and merged without them, and so that landing them later makes a client mechanism redundant rather than wrong.

### D10. Bytes and their order are never changed by the client

The client's role on the output path stays what the passthrough rule says (`docs/architecture.md:91`): the pacer decides
**when** bytes reach the VT, never what they are. Replay mode and catch-up only change timing and the paint hold. The
only local bytes written remain the ones written today (`FULL_RESET`, the cursor-style sequence).

## 4. Residuals a reviewer should know

- The first key of every epoch, including the first key after each Enter, appears only with its echo (D3, corrected).
- After a refused key in continuous typing (Enter, an arrow, the right margin under P4), the keys in flight move the
  real cursor where the predictor cannot follow, so predictions stay silent until typing pauses for about an expiry.
  Nothing drawn vanishes (the 200-key wrapping run records zero resets and 8 silent `killEpoch`s, 74 of 200 keys
  drawn); mosh has the same re-anchoring after a kill. Predicting the last column and the wrap as mosh does (P4) would
  remove the margin case.
- A large backlog returns as snapshots one RTT apart, not instantly (D5).
- Scrollback older than 2000 lines is lost on a reconnect (today's behaviour, kept; D5).
- Replay mode's end is a bound, not a marker (D5); a tail may be paced.
- One round trip of typing delay after returning to the app (D6).

## 5. Asks to herdr-core (filed, not gates)

1. Bracket the attach first paint in `ESC[?2026h … ESC[?2026l` instead of starting with `ESC[?2026l` (#812's proposal;
   `crates/ghostty-vt/src/lib.rs:710`). Makes D5's replay mode redundant.
2. Report the pty's ECHO flag (termios) as a viewer-visible fact (a `Terminal` field or a stream frame), so a client can
   suppress prediction exactly where the program does not echo. Lets the first key after Enter be drawn again wherever
   the program echoes (D3's residual).
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
