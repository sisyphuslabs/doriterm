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
});
