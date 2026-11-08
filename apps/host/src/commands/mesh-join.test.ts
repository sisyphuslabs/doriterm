import { base64urlEncode, hostIdOf } from "@doriface/crypto";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlRequest, listenControl } from "../control.ts";
import { meshJoinCommand } from "./mesh-join.ts";

const key = (byte: number): string => base64urlEncode(new Uint8Array(32).fill(byte));
const LINK = `doriface://pair#h=${hostIdOf(new Uint8Array(32).fill(2))}&k=${key(1)}&s=${key(2)}&p=${key(3)}&r=wss%3A%2F%2Frelay.example&m=1`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs `mesh join <args>` against a running host's control socket that answers every join. */
async function joinWith(args: readonly string[]): Promise<readonly ControlRequest[]> {
  const dir = mkdtempSync(join(tmpdir(), "dh-mesh-join-"));
  dirs.push(dir);
  const asked: ControlRequest[] = [];
  const control = listenControl(dir, async (request) => {
    asked.push(request);
    return { meshId: "m1" };
  });
  try {
    await meshJoinCommand(
      ["join", ...args.map((arg) => arg.replace("<dir>", dir)), "--state-dir", dir],
      () => {},
      () => {},
    );
  } finally {
    control.stop();
  }
  return asked;
}

test("mesh join --from-file joins with the link the file holds (#821)", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "dh-join-link-")), "link");
  dirs.push(join(file, ".."));
  writeFileSync(file, `${LINK}\n`, { mode: 0o600 });
  const asked = await joinWith(["--from-file", file, "--yes"]);
  expect(
    asked.filter((request) => request.op === "mesh-join").map((request) => Reflect.get(request, "target")),
  ).toEqual([LINK]);
});

test("mesh join refuses a link and --from-file together, and an empty file, before asking the host (#821)", async () => {
  const empty = join(mkdtempSync(join(tmpdir(), "dh-join-link-")), "link");
  dirs.push(join(empty, ".."));
  writeFileSync(empty, "\n");
  await expect(joinWith([LINK, "--from-file", empty, "--yes"])).rejects.toThrow();
  await expect(joinWith(["--from-file", empty, "--yes"])).rejects.toThrow();
});
