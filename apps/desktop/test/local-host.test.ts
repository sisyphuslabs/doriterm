import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_RELAY_URL } from "@doriface/crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcSession, type HcSession } from "../../host/src/testing/hc-session.ts";
import { LocalHost, LocalHostStartError } from "../src/main/local-host.ts";
import type { LocalHostFailure } from "../src/shared/bridge.ts";

const cli = join(import.meta.dir, "..", "..", "host", "src", "cli.ts");
const logs: string[] = [];
let session: HcSession;
let host: LocalHost;

const openSocket = (url: string, protocols: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols);
    socket.addEventListener("open", () => {
      resolve(socket.protocol);
      socket.close();
    });
    socket.addEventListener("error", () => reject(new Error("refused")));
  });

beforeAll(() => {
  session = createHcSession("doriface-desktop-test");
  host = new LocalHost({
    command: { file: process.execPath, args: [cli] },
    hc: () => session.hc,
    cwd: tmpdir(),
    env: session.env,
    log: (line) => logs.push(line),
  });
});

afterAll(async () => {
  await host.stop();
  await session.dispose();
});

describe("LocalHost against the workspace doriface-host and a real hc", () => {
  test("starts once on an ephemeral loopback port and admits only its token", async () => {
    const endpoint = await host.start();
    expect(endpoint.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/v1\/hc$/);
    expect(endpoint.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await host.start()).toBe(endpoint);

    const health = await fetch(endpoint.url.replace(/^ws:/, "http:").replace(/\/v1\/hc$/, "/healthz"));
    expect(health.status).toBe(200);
    expect(await openSocket(endpoint.url, ["doriface.v1", `doriface.token.${endpoint.token}`])).toBe("doriface.v1");
    await expect(
      openSocket(endpoint.url, ["doriface.v1", "doriface.token.wrong-token-wrong-token-xx"]),
    ).rejects.toThrow("refused");
  });

  test("a stopped host starts again on a fresh token", async () => {
    const first = await host.start();
    await host.stop();
    const second = await host.start();
    expect(second.token).not.toBe(first.token);
    expect(logs.some((line) => line.startsWith("doriface-host exited"))).toBe(true);
  });

  test("a start issued while a stopped child is still exiting keeps its own in-flight spawn", async () => {
    await host.stop();
    const abandoned = host.start();
    const stopped = host.stop();
    const restarted = host.start();
    await expect(abandoned).rejects.toThrow("exited before listening");
    await stopped;
    expect(host.start()).toBe(restarted);
    expect((await restarted).url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/v1\/hc$/);
  });

  test("a host that dies before listening rejects with its stderr, and the next start retries", async () => {
    const broken = new LocalHost({
      command: { file: process.execPath, args: ["-e", "console.error('boom'); process.exit(3)"] },
      hc: () => undefined,
      cwd: tmpdir(),
      env: process.env,
      log: () => {},
    });
    await expect(broken.start()).rejects.toThrow(/exited before listening \(code 3\):\nboom/);
    await expect(broken.start()).rejects.toThrow("exited before listening");
  });

  test("stderr that arrives after the exit event is still in the rejection", async () => {
    let exited = false;
    let writer: Bun.Socket | undefined;
    const release = (): void => void (exited && writer?.write("go"));
    const gate = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { open: (socket) => ((writer = socket), release()), data: () => {} },
    });
    const lateWriter = `const s = await Bun.connect({ hostname: "127.0.0.1", port: ${gate.port}, socket: { data: () => { console.error("boom"); process.exit(0); } } });`;
    const child = `Bun.spawn([process.execPath, "-e", ${JSON.stringify(lateWriter)}], { stdio: ["ignore", "ignore", "inherit"] }); process.exit(3);`;
    const dying = new LocalHost({
      command: { file: process.execPath, args: ["-e", child] },
      hc: () => undefined,
      cwd: tmpdir(),
      env: process.env,
      log: (line) => {
        if (!line.startsWith("doriface-host exited")) return;
        exited = true;
        release();
      },
    });
    try {
      await expect(dying.start()).rejects.toThrow(/exited before listening \(code 3\):\nboom/);
    } finally {
      gate.stop(true);
    }
  });
});

describe("the host the desktop app starts (#596)", () => {
  test("the host keeps its loopback listener and is told to dial the release relay, never --no-relay", async () => {
    const lines: string[] = [];
    const started = new LocalHost({
      command: { file: process.execPath, args: [join(import.meta.dir, "fixtures", "spawn-args.fixture.ts")] },
      hc: () => undefined,
      cwd: tmpdir(),
      env: process.env,
      log: (line) => lines.push(line),
    });
    try {
      await started.start();
    } finally {
      await started.stop();
    }
    const printed = lines.find((line) => line.includes("SPAWN-ARGS "));
    if (printed === undefined) throw new Error(`the host printed no arguments: ${lines.join("\n")}`);
    const args: string[] = JSON.parse(printed.slice(printed.indexOf("SPAWN-ARGS ") + "SPAWN-ARGS ".length));
    const valueOf = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    expect(args).not.toContain("--no-relay");
    expect(valueOf("--listen")).toBe("127.0.0.1:0");
    expect(args).toContain("--relay");
    expect(valueOf("--relay")).toBe(DEFAULT_RELAY_URL);
  });

  test("the host starts in the folder it is given, not the one the app was launched from (#2047)", async () => {
    // The app's own folder is wherever its launcher started it: a Windows shortcut's Start in is the install folder.
    // The host passes its folder to the core it starts, and a new terminal with no directory opens there.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "dd-home-")));
    const lines: string[] = [];
    const started = new LocalHost({
      command: { file: process.execPath, args: [join(import.meta.dir, "fixtures", "spawn-args.fixture.ts")] },
      hc: () => undefined,
      cwd: home,
      env: process.env,
      log: (line) => lines.push(line),
    });
    try {
      await started.start();
    } finally {
      await started.stop();
      rmSync(home, { recursive: true, force: true });
    }
    const printed = lines.find((line) => line.includes("SPAWN-CWD "));
    if (printed === undefined) throw new Error(`the host printed no folder: ${lines.join("\n")}`);
    expect(process.cwd()).not.toBe(home);
    expect(printed.slice(printed.indexOf("SPAWN-CWD ") + "SPAWN-CWD ".length)).toBe(home);
  });
});

describe("LocalHost when doriface-host cannot start", () => {
  let stateDir: string;
  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "dd-local-fail-"));
  });
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

  const failureOf = async (
    command: { file: string; args: string[] },
    hc: string | undefined,
    searched?: readonly string[],
  ): Promise<LocalHostFailure> => {
    const starting = new LocalHost({
      command,
      hc: () => hc,
      ...(searched === undefined ? {} : { searched: () => searched }),
      cwd: tmpdir(),
      env: { ...process.env, DORIFACE_HOST_STATE_DIR: stateDir },
      log: () => {},
    });
    const error: unknown = await starting.start().then(
      () => new Error("the host started"),
      (reason: unknown) => reason,
    );
    if (!(error instanceof LocalHostStartError))
      throw new Error(`expected a LocalHostStartError, got ${String(error)}`);
    return error.failure;
  };

  test("a missing hc rejects with hc-binary-missing and the path it tried, and no usage text", async () => {
    const missing = join(stateDir, "no-such-hc");
    const failure = await failureOf({ file: process.execPath, args: [cli] }, missing);
    expect(failure).toMatchObject({ code: "hc-binary-missing", path: missing });
    expect(failure.details).not.toContain("usage:");
  });

  test("a command line the host refuses keeps its error line but never its usage text", async () => {
    const failure = await failureOf({ file: process.execPath, args: [cli, "--no-such-flag"] }, undefined);
    expect(failure.code).toBe("host-exited");
    expect(failure.details).toContain("no-such-flag");
    expect(failure.details).not.toContain("usage:");
  });

  test("herdr-core not found on PATH carries the folders searched after it, for the copy to name", async () => {
    const searched = [join(stateDir, "a"), join(stateDir, "b")];
    const failure = await failureOf({ file: process.execPath, args: [cli] }, join(stateDir, "no-hc"), searched);
    expect(failure).toMatchObject({ code: "hc-binary-missing", searched });
    const other = await failureOf({ file: process.execPath, args: [cli, "--no-such-flag"] }, undefined, searched);
    expect(other.searched).toBeUndefined();
  });

  test("a doriface-host that cannot be run at all is host-spawn-failed", async () => {
    const failure = await failureOf({ file: join(stateDir, "no-such-host"), args: [] }, undefined);
    expect(failure.code).toBe("host-spawn-failed");
  });
});
