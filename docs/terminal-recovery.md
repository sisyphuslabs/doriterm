# Terminal connection recovery

A terminal viewer retries an interrupted attach three times before showing the failure. The delays are 250, 500
and 1000 ms, each independently jittered by 20% in either direction. Each recovery attach has a 2-second response
deadline; the initial attach keeps the existing client deadline. The automatic recovery after that first failure
takes at most 8.1 seconds of foreground scheduling (2.1 seconds waiting and three 2-second attempts). A browser
that suspends timers can take longer. The pane says Reconnecting while it waits.

The retry admits typed connection closure, timeout, silent-link and stream-loss failures, plus the core's
unavailable, unreachable, timeout and connection_closed RPC kinds. Older cores' specific internal response
`machine … is unreachable/unavailable` is also transient. Authentication, malformed requests, protocol errors,
stable missing targets and unknown errors are not retried automatically. The existing terminal lifecycle read
still distinguishes a terminal that ended from one whose stream ended.
WebSocket/relay closure codes 1001, 1005, 1006, 1011, 1012, 1013, 4404, 4408, 4409 and 4412 are transient;
authentication and invalid-frame codes are terminal. A secured link's error carries its transport's close code and is
judged by it. A relay's 4404 means its host is currently offline, not a stable fact that the machine does not exist.
A stream that ended because its connection dropped is always transient: the next connection re-attaches it.

Pressing into the pane, keys, paste, wheel or touch scrolling inside it and a pane becoming visible advance its
pending retry. Focus and scroll events alone do not: the view focuses and scrolls the pane itself. An attempt that
came due while the pane was hidden runs as soon as it is shown. The phone input row uses the same recovery path. A leading interaction may advance a pending attempt at most once per 250 ms;
it never resets the attempt count. After exhaustion, exactly one fresh bounded cycle is allowed after at least one
second without an interaction. Further input cannot reopen that outage's budget, even after another quiet interval.
An explicit manual retry, a changed target or a connection that stayed healthy for ten seconds starts a new budget.
Terminal failures require the explicit Try again button. Requests already in flight are not duplicated.
Only terminal.attach is retried. No terminal.run, message, file upload or previously sent input is replayed.

## Measurement

The browser records anonymous counters in this tab's sessionStorage key `doriterm.terminal-recovery.v1`. They
survive reloads in that tab and expire when the tab closes. The `since` field starts the observation window.
No terminal contents, addresses, machine identities or error text are recorded, and nothing is uploaded.
Each update also emits a `doriterm:terminal-recovery` CustomEvent with `{counter, counts}` for a local
diagnostics consumer. Export a window from browser developer tools with:

```js
JSON.parse(sessionStorage.getItem("doriterm.terminal-recovery.v1"));
```

- `views` counts terminal viewers that actually attempt to attach. This is the traffic denominator.
- `attachAttempts` includes initial attempts and recovery attempts.
- `errorsShown` counts failure screens exposed while their pane is visible.
- `manualRetries` counts explicit Try again actions.
- `manualImmediateSuccesses` counts manual retries whose first attach succeeds within 2000 ms, with no
  intervening failed attempt. Later automatic success never counts as immediate manual success.
- `automaticRecoveries` and `interactionRecoveries` count successful recoveries by their initiating path.

Compare `errorsShown / views` in equal observation windows with the same usage mix. The missed-recovery signal
is `manualImmediateSuccesses / manualRetries`; a high value means users are still fixing failures the automatic
attempts missed. Keep both counts beside each ratio and treat zero denominators as no observation.
These client counters do not provide a fleet-wide before/after result without collecting comparable exports.
