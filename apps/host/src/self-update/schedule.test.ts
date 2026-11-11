import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releasePublicKey, signRelease } from "@doriface/crypto";
import { updatableBinary, verifyReleaseCommand } from "../commands/update.ts";
import { inRollout, rolloutPlace, updaterId } from "./rollout.ts";
import { CHECK_EVERY_MS, FIRST_CHECK_MS, scheduleSelfUpdate } from "./schedule.ts";
import type { UpdateOutcome } from "./self-update.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "self-update-"));
  dirs.push(dir);
  return dir;
};

test("the updater id is made once, kept private, and places the host by its hash alone", () => {
  const dir = scratch();
  const id = updaterId(join(dir, "state"));
  expect(updaterId(join(dir, "state"))).toBe(id);
  expect(statSync(join(dir, "state", "updater-id")).mode & 0o777).toBe(0o600);
  const place = rolloutPlace(id);
  expect(place >= 0 && place < 100).toBe(true);
  expect([inRollout(id, 0), inRollout(id, 100)]).toEqual([false, true]);
  const places = Array.from({ length: 2000 }, () => rolloutPlace(crypto.randomUUID()));
  const share = places.filter((p) => p < 25).length / places.length;
  expect(share > 0.2 && share < 0.3).toBe(true);
});

test("the service checks five minutes after start, then every six hours with jitter, and stops once updated", async () => {
  const timers: number[] = [];
  const runs: (() => void)[] = [];
  const outcomes: (UpdateOutcome | Error)[] = [
    { kind: "held", version: "0.1.17", rollout: 10 },
    new Error("get.doriterm.com answered HTTP 503"),
    { kind: "updated", version: "0.1.17" },
  ];
  const logged: string[] = [];
  const updated: string[] = [];
  scheduleSelfUpdate({
    check: async () => {
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("no more checks expected");
      return next;
    },
    onUpdated: (version) => updated.push(version),
    log: (line) => logged.push(line),
    timer: (run, ms) => {
      timers.push(ms);
      runs.push(run);
    },
    random: () => 0.5,
  });
  const tick = async (): Promise<void> => {
    runs.shift()?.();
    await Bun.sleep(0);
  };
  await tick();
  await tick();
  await tick();
  expect(timers).toEqual([FIRST_CHECK_MS, CHECK_EVERY_MS + 15 * 60 * 1000, CHECK_EVERY_MS + 15 * 60 * 1000]);
  expect(logged).toEqual([
    "doriface-host 0.1.17 is rolling out to 10% of hosts, not yet this one",
    "self-update: get.doriterm.com answered HTTP 503",
    "doriface-host 0.1.17 is installed; restarting into it",
  ]);
  expect(updated).toEqual(["0.1.17"]);
  expect(runs).toEqual([]);
});

test("verify-release accepts SHA256SUMS.txt signed by a trusted key and refuses any other", async () => {
  const dir = scratch();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const sums = join(dir, "SHA256SUMS.txt");
  const sig = join(dir, "SHA256SUMS.txt.sig");
  await Bun.write(sums, `${"a".repeat(64)}  doriface-host-linux-x64\n`);
  await Bun.write(sig, signRelease(await Bun.file(sums).bytes(), key));
  const said: string[] = [];
  expect(await verifyReleaseCommand([sums, sig], (text) => said.push(text), [releasePublicKey(key)])).toBe(0);
  expect(await verifyReleaseCommand([sums, sig], (text) => said.push(text), [])).toBe(1);
  await Bun.write(sums, `${"b".repeat(64)}  doriface-host-linux-x64\n`);
  expect(await verifyReleaseCommand([sums, sig], (text) => said.push(text), [releasePublicKey(key)])).toBe(1);
  expect(said[0]).toBe("SHA256SUMS.txt is signed by a Doriterm release key\n");
});

test("only a built doriface-host replaces itself, never bun running the source", () => {
  expect(updatableBinary("/home/a/.local/bin/doriface-host")).toBe("/home/a/.local/bin/doriface-host");
  expect(updatableBinary("/tmp/doriface-host-linux-x64")).toBe("/tmp/doriface-host-linux-x64");
  expect(updatableBinary("/home/a/.bun/bin/bun")).toBeUndefined();
  expect(updatableBinary("/Applications/Doriterm.app/Contents/MacOS/Doriterm")).toBeUndefined();
  // The desktop app's own host is the app's to update, never the command's (#1983).
  for (const bundled of [
    "/Applications/Doriterm.app/Contents/Resources/bin/doriface-host",
    "/opt/Doriterm/resources/bin/doriface-host",
    "/tmp/.mount_DoriteXYZ/resources/bin/doriface-host",
  ])
    expect([bundled, updatableBinary(bundled)]).toEqual([bundled, undefined]);
});
