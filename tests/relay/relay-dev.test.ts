import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { defer, runDeferred } from "./support/cleanup.ts";
import { liveAmong, liveDescendants } from "./support/processes.ts";
import { BindRace, type LocalRelayOptions, startLocalRelay } from "./support/relay-dev.ts";

/** Linux's default ephemeral range starts here; macOS's starts higher. */
const EPHEMERAL_FLOOR = 32_768;

afterEach(runDeferred);

/** An empty directory for a child process's TMPDIR, removed after the test. */
function scratchTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-dev-test-"));
  defer(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const relayDirsIn = (dir: string): string[] => readdirSync(dir).filter((name) => name.startsWith("relay-"));

const timeoutFixture = (tmp: string) => {
  const fixture = join(import.meta.dir, "fixtures", "relay-test-timeout.fixture.ts");
  return Bun.spawn(
    [process.execPath, "test", "--path-ignore-patterns", ".relay/**", `./${relative(process.cwd(), fixture)}`],
    { env: { ...process.env, TMPDIR: tmp }, stdout: "pipe", stderr: "pipe" },
  );
};

/** A port another process holds, as one that took a picked port before wrangler bound it would. */
function takenPort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  defer(() => listener.stop(true));
  return listener.port;
}

function counting(pick: (index: number, pickFree: () => number) => number): {
  readonly options: LocalRelayOptions;
  picks(): number;
} {
  let picks = 0;
  return { options: { pickPort: (pickFree) => pick(picks++, pickFree) }, picks: () => picks };
}

const failureOf = (start: Promise<unknown>): Promise<unknown> =>
  start.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("startLocalRelay", () => {
  test("an HTTP port taken between the pick and wrangler's bind is retried on a freshly picked port", async () => {
    const taken = takenPort();
    const picker = counting((index, pickFree) => (index === 0 ? taken : pickFree()));
    const relay = await startLocalRelay({}, picker.options);
    defer(() => relay.stop());
    const port = Number(new URL(relay.url).port);
    expect(picker.picks()).toBe(2);
    expect(port).not.toBe(taken);
    expect(port).toBeLessThan(EPHEMERAL_FLOOR);
    expect((await fetch(`${relay.url}/healthz`)).status).toBe(200);
  }, 120_000);

  test("a start failure that is not a bind race on the picked port is not retried", async () => {
    const picker = counting(() => 70_000);
    const failure = await failureOf(startLocalRelay({}, picker.options));
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(BindRace);
    expect(picker.picks()).toBe(1);
  }, 120_000);

  test("a picked port taken on every attempt fails as a bind race on the third", async () => {
    const ports: number[] = [];
    const picker = counting(() => {
      const port = takenPort();
      ports.push(port);
      return port;
    });
    const failure = await failureOf(startLocalRelay({}, picker.options));
    expect(picker.picks()).toBe(3);
    expect(failure).toBeInstanceOf(BindRace);
    expect(failure instanceof BindRace ? failure.port : undefined).toBe(ports[2]);
  }, 120_000);

  test("stop() returns only once every process wrangler dev started has exited", async () => {
    const relay = await startLocalRelay();
    defer(() => relay.stop());
    const started = await liveDescendants(process.pid);
    expect(started.length).toBeGreaterThanOrEqual(3);
    // Every process below the launcher is stopped, and a stopped process ignores SIGTERM until it is continued: only a
    // stop that reaches the whole group and escalates to SIGKILL ends them, whatever wrangler's own shutdown does.
    for (const pid of started.slice(1)) process.kill(pid, "SIGSTOP");
    await relay.stop();
    expect(await liveAmong(started)).toEqual([]);
  }, 120_000);

  test("a process ended by a signal takes the relay it started down with it", async () => {
    const tmp = scratchTmp();
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "relay-until-signal.ts")], {
      env: { ...process.env, TMPDIR: tmp },
      stdout: "pipe",
      stderr: "inherit",
    });
    defer(() => proc.kill("SIGKILL"));
    const reader = proc.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
    const started = await liveDescendants(proc.pid);
    expect(started.length).toBeGreaterThanOrEqual(3);
    expect(relayDirsIn(tmp)).toHaveLength(1);
    proc.kill("SIGTERM");
    await proc.exited;
    expect(proc.signalCode).toBe("SIGTERM");
    expect(await liveAmong(started)).toEqual([]);
    expect(relayDirsIn(tmp)).toEqual([]);
  }, 120_000);

  test("a relay a test never stopped is stopped, and its scratch removed, once the test run ends", async () => {
    const tmp = scratchTmp();
    const fixture = join(import.meta.dir, "fixtures", "relay-left-running.fixture.ts");
    const proc = Bun.spawn(
      [process.execPath, "test", "--path-ignore-patterns", ".relay/**", `./${relative(process.cwd(), fixture)}`],
      { env: { ...process.env, TMPDIR: tmp }, stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(0);
    const pids: unknown = JSON.parse(readFileSync(join(tmp, "pids.json"), "utf8"));
    if (!Array.isArray(pids) || !pids.every((pid) => typeof pid === "number")) throw new Error("bad pid list");
    expect(pids.length).toBeGreaterThanOrEqual(3);
    expect(await liveAmong(pids)).toEqual([]);
    expect(relayDirsIn(tmp)).toEqual([]);
  }, 180_000);

  test("a file's afterAll stop that must escalate to SIGKILL finishes inside its hook and leaves no process", async () => {
    const tmp = scratchTmp();
    const fixture = join(import.meta.dir, "fixtures", "relay-stop-escalates.fixture.ts");
    const proc = Bun.spawn(
      [process.execPath, "test", "--path-ignore-patterns", ".relay/**", `./${relative(process.cwd(), fixture)}`],
      { env: { ...process.env, TMPDIR: tmp }, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(stderr).not.toContain("hook timed out");
    expect(code).toBe(0);
    const pids: unknown = JSON.parse(readFileSync(join(tmp, "pids.json"), "utf8"));
    if (!Array.isArray(pids) || !pids.every((pid) => typeof pid === "number")) throw new Error("bad pid list");
    expect(await liveAmong(pids)).toEqual([]);
    expect(relayDirsIn(tmp)).toEqual([]);
  }, 180_000);

  describe("shared relay after a test timeout", () => {
    let result: { code: number; stdout: string; stderr: string; dirs: string[] };
    beforeAll(async () => {
      const tmp = scratchTmp();
      const proc = timeoutFixture(tmp);
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      result = { code, stdout, stderr, dirs: relayDirsIn(tmp) };
    }, 180_000);

    test("a timed-out relay test does not take the next test's relay down", () => {
      expect(result.stdout).toContain("waiting for the authenticated socket to close");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("(fail) a test blocked on an open socket times out");
      expect(result.stderr).toContain("this test timed out after 5000ms");
      expect(result.stderr).toContain("(pass) the next test can reach its relay");
      expect(result.dirs).toEqual([]);
    });
  });

  describe("shared relay after an interrupt", () => {
    let result: {
      signal: ReturnType<typeof timeoutFixture>["signalCode"];
      started: number[];
      live: number[];
      dirs: string[];
    };
    beforeAll(async () => {
      const tmp = scratchTmp();
      const proc = timeoutFixture(tmp);
      const stderr = new Response(proc.stderr).text();
      const reader = proc.stdout.getReader();
      const untilReady = async (output: string): Promise<void> => {
        if (output.includes("waiting for the authenticated socket to close")) return;
        const next = await reader.read();
        if (next.done) throw new Error(`fixture exited before ready: ${await stderr}`);
        return untilReady(output + new TextDecoder().decode(next.value));
      };
      await untilReady("");
      const started = await liveDescendants(proc.pid);
      proc.kill("SIGTERM");
      await proc.exited;
      await stderr;
      result = { signal: proc.signalCode, started, live: await liveAmong(started), dirs: relayDirsIn(tmp) };
    }, 120_000);

    test("interrupting a test runner stops its worker-owned shared relay", () => {
      expect(result.started.length).toBeGreaterThanOrEqual(3);
      expect(result.signal).toBe("SIGTERM");
      expect(result.live).toEqual([]);
      expect(result.dirs).toEqual([]);
    });
  });
});
