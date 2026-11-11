import type { Host } from "@doriface/host";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { HcSession } from "../../apps/host/src/testing/hc-session.ts";
import type { LocalRelay } from "./support/relay-dev.ts";
import { stopLeftUnder } from "../../apps/host/src/testing/run-dir.ts";
import { liveAmong, liveWithEnvironment } from "./support/processes.ts";
import { startRelayedHost } from "./support/relayed-host.ts";

/** Processes still running with this hc session in their environment: its core and any `hc connect` the host ran. */
function processesOf(session: string): string[] {
  const mine = `HC_SESSION=${session}`;
  return readdirSync("/proc").filter((pid) => {
    if (!/^\d+$/.test(pid)) return false;
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(mine);
    } catch {
      return false;
    }
  });
}

const refused = (url: string): Promise<boolean> =>
  fetch(url, { signal: AbortSignal.timeout(5_000) }).then(
    () => false,
    () => true,
  );

/** Reads the fixture's stdout into `seen` until it holds the line `line`; fails if the stream ends first. */
async function lineFrom(
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

describe("startRelayedHost", () => {
  test("an uplink that never connects rejects within its bound and tears everything down", async () => {
    // A scratch parent of this test's own: other suites running at the same time make scratch dirs in the shared tmp
    // dir, which a scan of it would count as this start's leftovers (#234).
    const root = mkdtempSync(join(tmpdir(), "relayed-host-test-"));
    let relay: LocalRelay | undefined;
    let session: HcSession | undefined;
    let host: Host | undefined;
    try {
      const startedAt = performance.now();
      const failure = await startRelayedHost("relay-unreachable", {
        hostRelayUrl: "http://127.0.0.1:9",
        uplinkTimeoutMs: 2_000,
        scratchRoot: root,
        started: (part) => {
          if ("relay" in part) relay = part.relay;
          if ("host" in part) host = part.host;
          if (!("session" in part)) return undefined;
          session = part.session;
          // A core of its own, as a host that served a client would have: the teardown must stop it.
          const direct = part.session.connect();
          direct.end();
          return direct.exited;
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(String(failure)).toContain("the host's relay uplink did not happen within 2000 ms");
      expect(performance.now() - startedAt).toBeLessThan(60_000);
      expect(readdirSync(root)).toEqual([]);
      // Every part it started is stopped (#40): the relay and the host listen no more, and the hc core and every
      // `hc connect` of the session have exited, with the session's state and runtime dirs gone.
      if (relay === undefined || session === undefined || host === undefined) throw new Error("a part never started");
      expect(await refused(relay.url)).toBe(true);
      expect(await refused(`http://127.0.0.1:${host.port}/healthz`)).toBe(true);
      expect(processesOf(session.name)).toEqual([]);
      const sessionDir = dirname(session.env["XDG_STATE_HOME"] ?? "");
      expect(["state", "run"].filter((part) => existsSync(join(sessionDir, part)))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("a file's afterAll stop whose relay must escalate to SIGKILL finishes inside its hook and leaves nothing running", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "relayed-stop-"));
    try {
      const fixture = join(import.meta.dir, "fixtures", "relayed-stop-escalates.fixture.ts");
      const proc = Bun.spawn(
        [process.execPath, "test", "--path-ignore-patterns", ".relay/**", `./${relative(process.cwd(), fixture)}`],
        { env: { ...process.env, TMPDIR: tmp }, stdout: "pipe", stderr: "pipe" },
      );
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(stderr).not.toContain("hook timed out");
      expect(code).toBe(0);
      const left: unknown = JSON.parse(readFileSync(join(tmp, "left.json"), "utf8"));
      if (typeof left !== "object" || left === null || !("pids" in left) || !("socket" in left))
        throw new Error("bad left.json");
      const { pids, socket } = left;
      if (!Array.isArray(pids) || !pids.every((pid) => typeof pid === "number") || typeof socket !== "string")
        throw new Error("bad left.json");
      expect(await liveAmong(pids)).toEqual([]);
      // The hc core: nothing answers on its socket any more.
      const answered = await Bun.connect({ unix: socket, socket: { data: () => {} } }).then(
        (probe) => {
          probe.end();
          return true;
        },
        () => false,
      );
      expect(answered).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 240_000);

  test("a process that ends on SIGTERM stops its relayed host first, hc core included, and leaves nothing (#2061)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "relayed-sigterm-"));
    try {
      const fixture = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "relayed-sigterm.fixture.ts")], {
        env: { ...process.env, TMPDIR: tmp },
        stdout: "pipe",
        stderr: "inherit",
      });
      let printed = "";
      for await (const chunk of fixture.stdout.pipeThrough(new TextDecoderStream())) {
        printed += chunk;
        if (printed.includes("READY\n")) break;
      }
      expect(printed).toContain("READY\n");
      fixture.kill("SIGTERM");
      await fixture.exited;
      // No hc process holds a file under its tmp dir: its core, with a terminal on it, runs as a daemon outside every
      // process group of the fixture, so only the host's orderly stop ends it. Every other process it started has ended
      // too, and the host's and the session's scratch is gone (the stop's last steps; wrangler leaves files of its own
      // there, such as miniflare-* and update-check).
      expect(await stopLeftUnder(tmp)).toEqual([]);
      expect(await liveWithEnvironment(`TMPDIR=${tmp}`)).toEqual([]);
      expect(readdirSync(tmp).filter((name) => name.startsWith("rh-") || name.startsWith("dh-"))).toEqual([]);
    } finally {
      await stopLeftUnder(tmp);
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  const startupCases = [
    ...(["relay", "session", "host"] as const).map((stage) => ({
      stage,
      title: `a SIGTERM while start-up holds after the ${stage} has started ends start-up there, and leaves nothing (#2080)`,
      env: {},
      settled: "interrupted",
    })),
    {
      // An uplink wait longer than the interrupt hook's own budget (30 s): one that ran to its end would leave the hook
      // to kill the groups and end the process before the host and its hc core had stopped.
      stage: "uplink",
      title:
        "a SIGTERM during the uplink wait, to a relay that never answers, ends start-up at once and leaves nothing (#2131)",
      env: { HOST_RELAY_URL: "http://127.0.0.1:9", UPLINK_MS: "60000" },
      settled: "interrupted",
    },
    {
      stage: "teardown",
      title: "a SIGTERM while a failed start-up tears down waits for that teardown, and leaves nothing (#2131)",
      env: {},
      settled: "start-up failed on purpose",
    },
    {
      // The pair CLI start-up runs last has no bound of its own: one that never exits must not hold the interrupt past
      // the hook's budget either.
      stage: "pair",
      title:
        "a SIGTERM while start-up waits on a pair CLI that never exits ends start-up at once, and leaves nothing (#2155)",
      env: { PAIR_CLI: join(import.meta.dir, "fixtures", "pair-never-exits.fixture.ts") },
      settled: "interrupted",
    },
    {
      // A relay start that never finishes, as one that retries for minutes looks to the interrupt hook (#2220).
      stage: "relay-start",
      title: "a SIGTERM during a relay start that never finishes ends start-up at once, and leaves nothing (#2220)",
      env: {},
      settled: "interrupted",
    },
    {
      // The relay start finishes on the SIGTERM itself, after start-up has seen the interrupt (#2232).
      stage: "relay-late",
      title: "a relay whose start finishes after a SIGTERM is stopped, and start-up ends as interrupted (#2232)",
      env: {},
      settled: "interrupted",
    },
    {
      // The same, but stopping that late relay fails: start-up still ends as interrupted, and the failure is reported.
      stage: "relay-late-fail",
      title: "a late relay whose stop fails is reported, and start-up still ends as interrupted (#2239)",
      env: {},
      settled: "interrupted",
    },
  ];
  test("a start-up that fails before its hold ends the fixture, and the reason is on stderr (#2268)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "relayed-startup-"));
    const out = mkdtempSync(join(tmpdir(), "relayed-startup-out-"));
    try {
      const fixture = Bun.spawn(
        [process.execPath, join(import.meta.dir, "fixtures", "relayed-startup-sigterm.fixture.ts")],
        {
          env: { ...process.env, TMPDIR: tmp, STAGE: "relay-fail", SETTLED_FILE: join(out, "settled") },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stderr = new Response(fixture.stderr).text();
      // Bounded: the stdin stays open, as in the other cases, so a fixture that waited on it would never exit.
      const ended = await Promise.race([
        fixture.exited.then(() => "exited"),
        Bun.sleep(20_000).then(() => "still running"),
      ]);
      if (ended !== "exited") fixture.kill("SIGKILL");
      const errors = await stderr;
      process.stderr.write(errors);
      expect(ended).toBe("exited");
      expect(errors).toContain("the relay start failed on purpose");
      expect(await stopLeftUnder(tmp)).toEqual([]);
    } finally {
      await stopLeftUnder(tmp);
      rmSync(tmp, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
  for (const { stage, title, env, settled } of startupCases) {
    test(
      title,
      async () => {
        const tmp = mkdtempSync(join(tmpdir(), "relayed-startup-"));
        const out = mkdtempSync(join(tmpdir(), "relayed-startup-out-"));
        const settledFile = join(out, "settled");
        try {
          const fixture = Bun.spawn(
            [process.execPath, join(import.meta.dir, "fixtures", "relayed-startup-sigterm.fixture.ts")],
            {
              // PAIR_MARK: the file the stub pair CLI writes once it runs, which the fixture watches for (#2155).
              env: {
                ...process.env,
                ...env,
                TMPDIR: tmp,
                STAGE: stage,
                SETTLED_FILE: settledFile,
                PAIR_MARK: join(out, "pair-held"),
                LATE_MARK: join(out, "late-stopped"),
              },
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          // Piped only to be read: each chunk goes on to the test output as it arrives, so a case that hangs or throws
          // still shows the fixture's stderr.
          const stderr = (async () => {
            let text = "";
            for await (const chunk of fixture.stderr.pipeThrough(new TextDecoderStream())) {
              process.stderr.write(chunk);
              text += chunk;
            }
            return text;
          })();
          const reader = fixture.stdout.pipeThrough(new TextDecoderStream()).getReader();
          const seen = { text: "" };
          await lineFrom(reader, seen, `STAGE ${stage}`);
          fixture.kill("SIGTERM");
          await lineFrom(reader, seen, "SIGNALLED");
          // Start-up goes on only now, after the interrupt: it must end at its next step rather than race the teardown.
          fixture.stdin.write("GO\n");
          await fixture.stdin.flush();
          await fixture.exited;
          const errors = await stderr;
          expect(existsSync(settledFile) ? readFileSync(settledFile, "utf8") : "never settled").toContain(settled);
          if (stage === "relay-late") expect(existsSync(join(out, "late-stopped"))).toBe(true);
          // The fixture's own error message, so a failed late stop that went unreported would fail here (#2239).
          if (stage === "relay-late-fail") expect(errors).toContain("the late relay's stop failed on purpose");
          expect(await stopLeftUnder(tmp)).toEqual([]);
          expect(await liveWithEnvironment(`TMPDIR=${tmp}`)).toEqual([]);
          expect(readdirSync(tmp).filter((name) => name.startsWith("rh-") || name.startsWith("dh-"))).toEqual([]);
        } finally {
          await stopLeftUnder(tmp);
          rmSync(tmp, { recursive: true, force: true });
          rmSync(out, { recursive: true, force: true });
        }
      },
      120_000,
    );
  }
});
