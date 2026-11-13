// #2399: a desktop e2e launch must never start the app's host against the release relay. This is the spec side of
// that contract: the launch helper the specs spread into electron.launch() hands the app's host a wrapper that dials
// a relay the run owns, so a spec cannot leave the host on the release relay and open a Room on it.
// apps/desktop/test/local-host.test.ts keeps the other side: a real (non-e2e) launch dials the release relay.
import { afterAll, describe, expect, test } from "bun:test";
import { DEFAULT_RELAY_URL } from "@doriface/crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedEnv, stopHostRig } from "../e2e/launch.ts";
import { writeHostWrapper } from "../e2e/host-wrapper.ts";
import { hostCommand } from "../src/main/host-command.ts";
import { LocalHost } from "../src/main/local-host.ts";

// Prints the arguments it was given as the wrapper's host child, and the line LocalHost waits for; never dials.
const fixture = join(import.meta.dir, "fixtures", "spawn-args.fixture.ts");

afterAll(async () => {
  await stopHostRig();
});

describe("an e2e app launch never starts its host against the release relay (#2399)", () => {
  test("the launch helper's env starts the app's host on a relay the run owns", async () => {
    // The way the specs build their env (string-only, as Playwright wants), with the fixture as the host the wrapper
    // starts, so the launch is observable without dialing anything.
    const spec = Object.fromEntries(
      Object.entries({ ...process.env, DORIFACE_E2E_HOST_CLI: fixture }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const env = await guardedEnv(spec);
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

  test("the production smoke keeps dialing the release relay", async () => {
    // hosted-relay-pair is the one e2e launch that must reach the production relay ("nothing is stood in"); the
    // guard passes its env through untouched.
    const env = await guardedEnv({ DORIFACE_HOSTED_RELAY_SMOKE: "1" });
    expect(env["DORIFACE_HOST_BIN"]).toBeUndefined();
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
