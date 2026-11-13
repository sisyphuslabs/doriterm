// #2399: a desktop e2e launch must never start the app's host against the release relay. This is the spec side of
// that contract: the launch helper the specs spread into electron.launch() hands the app's host a wrapper that dials
// a relay the run owns, so a spec cannot leave the host on the release relay and open a Room on it.
// apps/desktop/test/local-host.test.ts keeps the other side: a real (non-e2e) launch dials the release relay.
import { describe, expect, test } from "bun:test";
import { DEFAULT_RELAY_URL } from "@doriface/crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as launch from "../e2e/launch.ts";
import { hostCommand } from "../src/main/host-command.ts";
import { LocalHost } from "../src/main/local-host.ts";

// Prints the arguments it was given as the wrapper's host child, and the line LocalHost waits for; never dials.
const fixture = join(import.meta.dir, "fixtures", "spawn-args.fixture.ts");
const guardedEnvOf = (
  module: typeof launch,
): ((env: Record<string, string | undefined>) => Promise<Record<string, string | undefined>>) | undefined =>
  (module as unknown as { guardedEnv?: (env: Record<string, string | undefined>) => Promise<Record<string, string | undefined>> })
    .guardedEnv;

describe("an e2e app launch never starts its host against the release relay (#2399)", () => {
  test("the launch helper's env starts the app's host on a relay the run owns", async () => {
    const guardedEnv = guardedEnvOf(launch);
    // The way the specs build their env, with the fixture as the host the wrapper starts so the launch is observable.
    const spec = { ...process.env, DORIFACE_E2E_HOST_CLI: fixture };
    const env = guardedEnv === undefined ? spec : await guardedEnv(spec);
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
    expect(command.file).toBe(env["DORIFACE_HOST_BIN"]); // the app spawns the wrapper, not the bare CLI

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
    expect(valueOf("--relay")).toMatch(/^ws:\/\/127\.0\.0\.1:\d+/); // a relay this run owns, on loopback
  });
});

