import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HC_VERSION_RECOMMENDED } from "@doriface/protocol";
import { keepHcCurrent, type Ran } from "./hc-keep-current.ts";

const userHc = (): { hc: string; installDir: string } => {
  const installDir = join(mkdtempSync(join(tmpdir(), "dh-keep-")), "bin");
  mkdirSync(installDir);
  const hc = join(installDir, "hc");
  writeFileSync(hc, "#!/bin/sh\n");
  chmodSync(hc, 0o755);
  return { hc, installDir };
};
const ok = (stdout: string): Ran => ({ code: 0, stdout, stderr: "" });
const listed = (...addresses: string[]): Ran =>
  ok(JSON.stringify({ terminals: addresses.map((address) => ({ address })) }));

function fakeHc(lists: Ran[], update: Ran, to: string) {
  const calls: string[][] = [];
  const run = (argv: readonly string[]): Promise<Ran> => {
    calls.push(argv.slice(1));
    if (argv[1] === "ls") return Promise.resolve(lists.shift() ?? listed());
    if (argv[1] === "update") return Promise.resolve(update);
    return Promise.resolve(ok(`hc ${to}\n`));
  };
  return { calls, run };
}

test("an older hc in the user's own folder is updated to the recommended version, and every terminal is checked kept", async () => {
  const { hc, installDir } = userHc();
  const fake = fakeHc([listed("t1", "t2"), listed("t1", "t2", "t3")], ok("{}"), HC_VERSION_RECOMMENDED);
  const logs: string[] = [];
  const result = await keepHcCurrent({
    hc,
    installDir,
    version: "0.1.21",
    env: {},
    run: fake.run,
    log: (line) => logs.push(line),
  });
  expect(result).toEqual({ kind: "updated", from: "0.1.21", to: HC_VERSION_RECOMMENDED, terminals: 2 });
  expect(fake.calls).toEqual([
    ["ls", "--json"],
    ["update", "--version", HC_VERSION_RECOMMENDED, "--json"],
    ["--version"],
    ["ls", "--json"],
  ]);
  expect(logs.at(-1)).toContain("all 2 terminals kept running");
});

test("a terminal missing after the update, a failed update, or an old version afterwards is a failure, not a success", async () => {
  const { hc, installDir } = userHc();
  const deps = { hc, installDir, version: "0.1.21", env: {}, log: () => {} };
  const lost = await keepHcCurrent({
    ...deps,
    run: fakeHc([listed("t1", "t2"), listed("t1")], ok("{}"), HC_VERSION_RECOMMENDED).run,
  });
  expect(lost).toEqual({ kind: "failed", reason: "terminals missing after the update: t2" });
  const refused = await keepHcCurrent({
    ...deps,
    run: fakeHc([listed()], { code: 1, stdout: "", stderr: "no network" }, "0.1.21").run,
  });
  expect(refused).toEqual({ kind: "failed", reason: "hc update failed: no network" });
  const stale = await keepHcCurrent({ ...deps, run: fakeHc([listed(), listed()], ok("{}"), "0.1.21").run });
  expect(stale).toEqual({ kind: "failed", reason: "hc reports 0.1.21 after the update" });
});

test("nothing runs when hc is current, opted out, or installed outside the user's own folder", async () => {
  const { hc, installDir } = userHc();
  const fake = fakeHc([], ok("{}"), HC_VERSION_RECOMMENDED);
  const base = { hc, installDir, env: {}, run: fake.run, log: () => {} };
  expect(await keepHcCurrent({ ...base, version: HC_VERSION_RECOMMENDED })).toMatchObject({ kind: "skipped" });
  expect(await keepHcCurrent({ ...base, version: "0.1.21", env: { DORIFACE_HC_AUTO_UPDATE: "0" } })).toMatchObject({
    kind: "skipped",
    reason: "DORIFACE_HC_AUTO_UPDATE=0",
  });
  const managed = await keepHcCurrent({
    ...base,
    version: "0.1.21",
    installDir: mkdtempSync(join(tmpdir(), "dh-other-")),
  });
  expect(managed).toMatchObject({
    kind: "skipped",
    reason: "installed outside the user's own folder, so its owner updates it",
  });
  expect(fake.calls).toEqual([]);
});
