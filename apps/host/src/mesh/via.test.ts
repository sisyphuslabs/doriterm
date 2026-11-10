import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostIdFor } from "./testing/hc-mesh.ts";
import { meshHostOf, meshVia } from "./via.ts";

const root = mkdtempSync(join(tmpdir(), "via-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the pinned via (R-1)", () => {
  test("survives herdr's sh -c with a space and a quote in both paths, and hands over the member and the line", async () => {
    const bin = join(root, "it's bin");
    mkdirSync(bin);
    const program = join(bin, "doriface-host");
    writeFileSync(program, '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done\n');
    chmodSync(program, 0o755);
    const stateDir = join(root, "st 'a");
    const hostId = hostIdFor("b");
    const via = meshVia(program, stateDir, hostId);
    const child = Bun.spawn(["sh", "-c", `${via} "$1"`, "sh", "HC_SESSION=x herdr-core connect"], { stdout: "pipe" });
    const args = (await new Response(child.stdout).text()).trimEnd().split("\n");
    expect(await child.exited).toBe(0);
    expect(args).toEqual(["connect", "--mesh", "--state-dir", stateDir, hostId, "HC_SESSION=x herdr-core connect"]);
    expect(meshHostOf(via, program, stateDir)).toBe(hostId);
  });

  test("refuses a hostId that is not one, so nothing reaches the shell unquoted", () => {
    for (const hostId of ["x$(touch PWN)", "x; touch PWN #", hostIdFor("b").toUpperCase(), ""]) {
      expect(() => meshVia("/opt/doriface-host", "/state", hostId)).toThrow(TypeError);
    }
  });

  test("only this binary's exact mesh form is a mesh machine", () => {
    const hostId = hostIdFor("b");
    const via = meshVia("/opt/doriface-host", "/state", hostId);
    expect(meshHostOf(via, "/opt/doriface-host", "/state")).toBe(hostId);
    expect(
      meshHostOf(`'/opt/doriface-host' connect --mesh --state-dir '/state' ${hostId}`, "/opt/doriface-host", "/state"),
    ).toBe(hostId);
    expect(meshHostOf(`'/opt/doriface-host' connect ${hostId}`, "/opt/doriface-host", "/state")).toBeUndefined();
    expect(meshHostOf(via, "/other/doriface-host", "/state")).toBeUndefined();
    expect(meshHostOf(via, "/opt/doriface-host", "/other")).toBeUndefined();
    expect(meshHostOf(`${via}; rm -rf ~`, "/opt/doriface-host", "/state")).toBeUndefined();
  });
});

describe("the pinned via per platform (#1385)", () => {
  const hostId = hostIdFor("b");
  const exe = String.raw`C:\Program Files\Doriterm\doriface-host.exe`;
  const state = String.raw`C:\Users\me\AppData\Roaming\doriface\state`;

  test("POSIX: a sh -c line that execs the quoted program", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(meshVia("/opt/doriface-host", "/state", hostId, platform)).toBe(
        `exec '/opt/doriface-host' connect --mesh --state-dir '/state' ${hostId}`,
      );
    }
  });

  test("Windows: the program and its arguments with no shell, each path one Windows argument", () => {
    const via = meshVia(exe, state, hostId, "win32");
    expect(via).toBe(`"${exe}" connect --mesh --state-dir "${state}" ${hostId}`);
    expect(meshHostOf(via, exe, state, "win32")).toBe(hostId);
  });

  test("Windows: a trailing backslash cannot escape the closing quote, and a quote in a path is refused", () => {
    expect(meshVia(exe, "D:\\", hostId, "win32")).toBe(`"${exe}" connect --mesh --state-dir "D:\\\\" ${hostId}`);
    expect(() => meshVia(String.raw`C:\a"b\doriface-host.exe`, state, hostId, "win32")).toThrow(TypeError);
  });

  test("Windows: only a program Windows can start names a line; a script needs the compiled host", () => {
    expect(() => meshVia(String.raw`C:\src\apps\host\src\cli.ts`, state, hostId, "win32")).toThrow(/compiled/);
  });

  test("each platform reads only its own form", () => {
    const posix = meshVia("/opt/doriface-host", "/state", hostId, "linux");
    expect(meshHostOf(posix, "/opt/doriface-host", "/state", "win32")).toBeUndefined();
    const windows = meshVia(exe, state, hostId, "win32");
    expect(meshHostOf(windows, exe, state, "linux")).toBeUndefined();
    expect(meshHostOf(`${windows} & del x`, exe, state, "win32")).toBeUndefined();
  });
});
