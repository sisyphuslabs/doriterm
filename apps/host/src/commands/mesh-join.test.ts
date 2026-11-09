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
  const { asked, error } = await tryJoin(args);
  if (error !== undefined) throw error;
  return asked;
}

/** As `joinWith`, but a failed join returns its error beside what the host was asked by then. */
async function tryJoin(args: readonly string[]): Promise<{ asked: readonly ControlRequest[]; error: unknown }> {
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
    return { asked, error: undefined };
  } catch (error) {
    return { asked, error };
  } finally {
    control.stop();
  }
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
  const both = await tryJoin([LINK, "--from-file", empty, "--yes"]);
  expect(both.error).toBeInstanceOf(Error);
  expect((both.error as Error).message).toBe("mesh join takes a link or code, or --from-file, not both");
  expect(both.asked).toEqual([]);
  const none = await tryJoin(["--from-file", empty, "--yes"]);
  expect(none.error).toBeInstanceOf(Error);
  expect((none.error as Error).message).toBe(`${empty} holds no mesh pairing link or code`);
  expect(none.asked).toEqual([]);
});

test("mesh join --from-file joins with the file's first line, whatever follows it (#1200)", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "dh-join-link-")), "link");
  dirs.push(join(file, ".."));
  writeFileSync(file, `${LINK}\nwritten by a script after the link\n`, { mode: 0o600 });
  const asked = await joinWith(["--from-file", file, "--yes"]);
  expect(
    asked.filter((request) => request.op === "mesh-join").map((request) => Reflect.get(request, "target")),
  ).toEqual([LINK]);
});
