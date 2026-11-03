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

  test("only this binary's exact mesh form is a mesh machine", () => {
    const hostId = hostIdFor("b");
    const via = meshVia("/opt/doriface-host", "/state", hostId);
    expect(meshHostOf(via, "/opt/doriface-host", "/state")).toBe(hostId);
    expect(meshHostOf(`'/opt/doriface-host' connect ${hostId}`, "/opt/doriface-host", "/state")).toBeUndefined();
    expect(meshHostOf(via, "/other/doriface-host", "/state")).toBeUndefined();
    expect(meshHostOf(via, "/opt/doriface-host", "/other")).toBeUndefined();
    expect(meshHostOf(`${via}; rm -rf ~`, "/opt/doriface-host", "/state")).toBeUndefined();
  });
});
