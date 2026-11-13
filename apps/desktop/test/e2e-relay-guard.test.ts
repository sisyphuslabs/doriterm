// #2399: a desktop e2e launch must never start the app's host against the release relay. This is the spec side of
// that contract: the launch helper the specs spread into electron.launch() hands the app's host a wrapper that dials
// a relay the run owns, so a spec cannot leave the host on the release relay and open a Room on it.
// apps/desktop/test/local-host.test.ts keeps the other side: a real (non-e2e) launch dials the release relay.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_RELAY_URL } from "@doriface/crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHostWrapper } from "../e2e/host-wrapper.ts";
import { hostCommand } from "../src/main/host-command.ts";
import { LocalHost } from "../src/main/local-host.ts";

// The #2457 review's LOW 1: importing launch.ts runs pinRunDir, which would make its own /tmp/ddr-* dir and rewrite
// TMPDIR for the rest of this bun test process. Pin the run dir to one this test file owns before the import.
const ownRunDir = mkdtempSync(join(tmpdir(), "dd-guard-"));
process.env["DORIFACE_E2E_RUN_DIR"] = ownRunDir;

// Prints the arguments it was given as the wrapper's host child, and the line LocalHost waits for; never dials.
const fixture = join(import.meta.dir, "fixtures", "spawn-args.fixture.ts");

let guardedEnv: (env?: Record<string, string>) => Promise<Record<string, string>>;
let launchOptions: (
  extra?: readonly string[],
  options?: { env?: Record<string, string>; gpu?: boolean },
) => Promise<
  { readonly args: string[]; readonly env: Record<string, string> } | {
    readonly executablePath: string;
    readonly args: string[];
    readonly env: Record<string, string>;
  }
>;
let stopHostRig: () => Promise<void>;

beforeAll(async () => {
  const launch = await import("../e2e/launch.ts");
  guardedEnv = launch.guardedEnv;
  launchOptions = launch.launchOptions;
  stopHostRig = launch.stopHostRig;
});

afterAll(async () => {
  await stopHostRig();
  delete process.env["DORIFACE_E2E_RUN_DIR"];
  rmSync(ownRunDir, { recursive: true, force: true });
});

const specEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries({ ...process.env, DORIFACE_E2E_HOST_CLI: fixture }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

describe("an e2e app launch never starts its host against the release relay (#2399)", () => {
  test("the launch helper's env starts the app's host on a relay the run owns", async () => {
    const env = await guardedEnv(specEnv());
    expect(
      env["DORIFACE_HOST_BIN"] ?? "",
      `the launch env leaves the app's host on --relay ${DEFAULT_RELAY_URL}: every e2e launch opens a Room on the production relay (#2399)`,
    ).not.toBe("");

    const command = hostCommand({
      packaged: false,
      resourcesPath: "",
      appPath: join(import.meta.dir, "..", "src"),
      platform: process.platform,
      home: tmpdir(),
      env,
    });
    const hostBin = env["DORIFACE_HOST_BIN"];
    if (hostBin === undefined) throw new Error("the guard env did not name the wrapper host binary");
    expect(command.file).toBe(hostBin); // the app spawns the wrapper, not the bare CLI

    const lines: string[] = [];
    const host = new LocalHost({
      command,
      hc: () => undefined,
      cwd: tmpdir(),
      env,
      log: (line) => lines.push(line),
    });
    try {
      await host.start();
    } finally {
      await host.stop();
    }
    const printed = lines.find((line) => line.includes("SPAWN-ARGS "));
    if (printed === undefined) throw new Error(`the host printed no arguments: ${lines.join("\n")}`);
    const args: string[] = JSON.parse(printed.slice(printed.indexOf("SPAWN-ARGS ") + "SPAWN-ARGS ".length));
    const valueOf = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    expect(valueOf("--relay"), "the host the e2e launch started was given no relay").toBeDefined();
    expect(valueOf("--relay"), "the host the e2e launch started dials the release relay (#2399)").not.toBe(
      DEFAULT_RELAY_URL,
    );
    expect(valueOf("--relay")).toMatch(/^https?:\/\/127\.0\.0\.1:\d+/); // a relay this run owns, on loopback

    // The wrapper recorded the launch: the app gave the release relay, and the host was started on the run's one.
    const recordsPath = env["DORIFACE_E2E_HOST_RECORDS"];
    if (recordsPath === undefined) throw new Error("the guard env did not name the wrapper record file");
    const records = readFileSync(recordsPath, "utf8")
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line) as { readonly givenRelay: string | null; readonly startedOn: string });
    const record = records.at(-1);
    if (record === undefined) throw new Error("the wrapper recorded no launch");
    expect(record.givenRelay).toBe(DEFAULT_RELAY_URL);
    expect(record.startedOn, "the wrapper started the host on the release relay (#2399)").not.toBe(DEFAULT_RELAY_URL);
    const givenToHost = valueOf("--relay");
    if (givenToHost === undefined) throw new Error("the host was given no relay to start on");
    expect(record.startedOn).toBe(givenToHost);
  });

  test("a launch that passes no env is still guarded (#2457 review MEDIUM)", async () => {
    // The pre-PR idiom electron.launch({ ...launchOptions(args), env }) must not type-check into an unguarded
    // process.env: the helper itself hands every launch a guarded env.
    const options = await launchOptions([]);
    expect(
      options.env?.["DORIFACE_HOST_BIN"] ?? "",
      "launchOptions without an env key hands the app an unguarded process.env: its host dials the release relay (#2399)",
    ).not.toBe("");
  });

  test("a runner-wide hosted-smoke variable does not switch the guard off for every spec (#2457 review)", async () => {
    // DORIFACE_HOSTED_RELAY_SMOKE in the runner's env only gates the smoke spec's skip; the guard must stay on for
    // every other spec of that suite. The one opt-out is the smoke spec's own DORIFACE_E2E_RELAY_GUARD.
    const env = await guardedEnv({ ...specEnv(), DORIFACE_HOSTED_RELAY_SMOKE: "1" });
    expect(
      env["DORIFACE_HOST_BIN"] ?? "",
      "a runner-wide DORIFACE_HOSTED_RELAY_SMOKE disabled the guard for every spec of the suite",
    ).not.toBe("");
  });

  test("the production smoke opts out itself, spec by spec", async () => {
    const env = await guardedEnv({ ...specEnv(), DORIFACE_E2E_RELAY_GUARD: "off" });
    expect(env["DORIFACE_HOST_BIN"]).toBeUndefined();
  });

  test("a packaged run starts the bundled host, not the checkout's source (#2457 review)", async () => {
    // The packaged CI job and the release AppImage step must keep testing the host binary that ships: in packaged
    // mode the wrapper's host is the one beside the app, never the checkout's host/src/cli.ts.
    const saved = process.env["DORIFACE_E2E_EXECUTABLE"];
    process.env["DORIFACE_E2E_EXECUTABLE"] = join(tmpdir(), "guard-packaged", "Doriterm");
    try {
      const env = await guardedEnv(specEnv());
      expect(env["DORIFACE_E2E_HOST_CLI"] ?? "").toMatch(/resources[\\/]bin[\\/]doriface-host(\.exe)?$/);
    } finally {
      if (saved === undefined) delete process.env["DORIFACE_E2E_EXECUTABLE"];
      else process.env["DORIFACE_E2E_EXECUTABLE"] = saved;
    }
  });

  test("the wrapper refuses to start the host on the release relay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dd-guard-"));
    try {
      const wrapper = join(dir, "host.ts");
      const records = join(dir, "records.jsonl");
      // A misconfigured rig: the stand-in is the release relay itself.
      writeHostWrapper(wrapper, {
        standInRelay: DEFAULT_RELAY_URL,
        releaseRelay: DEFAULT_RELAY_URL,
        hostCli: fixture,
        recordFile: records,
      });
      const child = Bun.spawn([process.execPath, wrapper], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(2);
      expect(stderr).toContain("refusing to start the host on the release relay");
      expect(stderr).not.toContain("SPAWN-ARGS"); // nothing was started
      expect(existsSync(records)).toBe(false); // and nothing was recorded as launched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
