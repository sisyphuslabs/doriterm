import { join } from "node:path";

/** Reads the fixture's stdout into `seen` until it holds the line `line`; fails if the stream ends first. */
export async function lineFrom(
  reader: { read(): Promise<{ readonly done: boolean; readonly value?: string | undefined }> },
  seen: { text: string },
  line: string,
): Promise<void> {
  while (!seen.text.split("\n").includes(line)) {
    // oxlint-disable-next-line no-await-in-loop -- one chunk at a time, until the line has arrived
    const next = await reader.read();
    if (next.done) throw new Error(`the fixture ended before printing ${line}: ${seen.text}`);
    seen.text += next.value ?? "";
  }
}

// resumes: the fixture holds on its stdin after the SIGTERM and goes on only at the test's GO. Every other stage ends
// on the SIGTERM alone and its fixture exits without reading stdin, so a GO written to it would race that exit and could
// fail with EPIPE (#2725).
export const startupCases = [
  ...(["relay", "session", "host"] as const).map((stage) => ({
    stage,
    title: `a SIGTERM while start-up holds after the ${stage} has started ends start-up there, and leaves nothing (#2080)`,
    env: {},
    settled: "interrupted",
    resumes: true,
  })),
  {
    // An uplink wait longer than the interrupt hook's own budget (30 s): one that ran to its end would leave the hook
    // to kill the groups and end the process before the host and its hc core had stopped.
    stage: "uplink",
    title:
      "a SIGTERM during the uplink wait, to a relay that never answers, ends start-up at once and leaves nothing (#2131)",
    env: { HOST_RELAY_URL: "http://127.0.0.1:9", UPLINK_MS: "60000" },
    settled: "interrupted",
    resumes: false,
  },
  {
    stage: "teardown",
    title: "a SIGTERM while a failed start-up tears down waits for that teardown, and leaves nothing (#2131)",
    env: {},
    settled: "start-up failed on purpose",
    // The failed start's teardown holds at the host's stop until GO.
    resumes: true,
  },
  {
    // The pair CLI start-up runs last has no bound of its own: one that never exits must not hold the interrupt past
    // the hook's budget either.
    stage: "pair",
    title:
      "a SIGTERM while start-up waits on a pair CLI that never exits ends start-up at once, and leaves nothing (#2155)",
    env: { PAIR_CLI: join(import.meta.dir, "..", "fixtures", "pair-never-exits.fixture.ts") },
    settled: "interrupted",
    resumes: false,
  },
  {
    // A relay start that never finishes, as one that retries for minutes looks to the interrupt hook (#2220).
    stage: "relay-start",
    title: "a SIGTERM during a relay start that never finishes ends start-up at once, and leaves nothing (#2220)",
    env: {},
    settled: "interrupted",
    resumes: false,
  },
  {
    // The relay start finishes on the SIGTERM itself, after start-up has seen the interrupt (#2232).
    stage: "relay-late",
    title: "a relay whose start finishes after a SIGTERM is stopped, and start-up ends as interrupted (#2232)",
    env: {},
    settled: "interrupted",
    resumes: false,
  },
  {
    // The same, but stopping that late relay fails: start-up still ends as interrupted, and the failure is reported.
    stage: "relay-late-fail",
    title: "a late relay whose stop fails is reported, and start-up still ends as interrupted (#2239)",
    env: {},
    settled: "interrupted",
    resumes: false,
  },
];
export const earlyFailures = [
  {
    title: "a start-up whose relay start fails before its hold ends the fixture, and the reason is on stderr (#2268)",
    env: { STAGE: "relay-fail" },
    reason: "the relay start failed on purpose",
  },
  {
    // The pair stage also watches for its mark: that watch must not keep the fixture running either. No relay checkout
    // fails start-up at its first step.
    title: "a pair-stage start-up that fails before its hold ends the fixture, and the reason is on stderr (#2268)",
    env: { STAGE: "pair" },
    reason: "no installed relay checkout",
  },
];
