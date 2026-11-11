import { base64urlEncode, hostIdOf } from "@doriface/crypto";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlRequest, listenControl } from "../control.ts";
import { meshJoinCommand, OFFER_WITHDRAWN_NOTICE } from "./mesh-join.ts";

const key = (byte: number): string => base64urlEncode(new Uint8Array(32).fill(byte));
const LINK = `doriface://pair#h=${hostIdOf(new Uint8Array(32).fill(2))}&k=${key(1)}&s=${key(2)}&p=${key(3)}&r=wss%3A%2F%2Frelay.example&m=1`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs `mesh join <args>` against a running host's control socket that answers every join with `answer`. */
async function joinWith(
  args: readonly string[],
  answer: Record<string, unknown> = { meshId: "m1" },
  out: (text: string) => void = () => {},
): Promise<readonly ControlRequest[]> {
  const dir = mkdtempSync(join(tmpdir(), "dh-mesh-join-"));
  dirs.push(dir);
  const asked: ControlRequest[] = [];
  const control = listenControl(dir, async (request) => {
    asked.push(request);
    return answer;
  });
  try {
    await meshJoinCommand(["join", ...args.map((arg) => arg.replace("<dir>", dir)), "--state-dir", dir], out, () => {});
  } finally {
    control.stop();
  }
  return asked;
}

test("mesh join tells its caller when the running host withdrew its own mesh invite to join", async () => {
  const said: string[] = [];
  await joinWith([LINK, "--yes"], { meshId: "m1", withdrewOffer: true }, (text) => void said.push(text));
  expect(said.join("")).toContain(OFFER_WITHDRAWN_NOTICE);
  const quiet: string[] = [];
  await joinWith([LINK, "--yes"], { meshId: "m1", withdrewOffer: false }, (text) => void quiet.push(text));
  expect(quiet.join("")).not.toContain(OFFER_WITHDRAWN_NOTICE);
});

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
