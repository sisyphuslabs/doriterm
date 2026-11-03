import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlRequest, listenControl } from "../control.ts";
import { meshStatus } from "../mesh/status.ts";
import { meshFixture } from "../testing/mesh-fixture.ts";
import { meshCommand } from "./mesh.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const status = meshStatus(meshFixture(NOW).sources, NOW);

/** Runs `mesh <args>` against a control socket that answers mesh-status with `answer`. */
async function run(args: readonly string[], answer: unknown): Promise<{ code: number; text: string }> {
  const dir = mkdtempSync(join(tmpdir(), "dh-mesh-"));
  const asked: ControlRequest[] = [];
  const control = listenControl(dir, async (request) => {
    asked.push(request);
    return answer;
  });
  let text = "";
  try {
    const code = await meshCommand([...args, "--state-dir", dir], (chunk) => {
      text += chunk;
    });
    expect(asked).toEqual([{ op: "mesh-status" }]);
    return { code, text };
  } finally {
    control.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("doriface-host mesh status", () => {
  test("--json prints the running host's status", async () => {
    const { code, text } = await run(["status", "--json"], status);
    expect(code).toBe(0);
    expect(JSON.parse(text)).toEqual(status);
  });

  test("the text form names every member with its hostId and fingerprint", async () => {
    const { code, text } = await run(["status"], status);
    expect(code).toBe(0);
    for (const member of status.members) {
      expect(text).toContain(`${member.name} ${member.hostId} ${member.fingerprint}`);
    }
    expect(text).toContain(status.members[2]?.revokeCommand ?? "missing");
  });

  test("a host in no mesh exits 1", async () => {
    expect((await run(["status"], null)).code).toBe(1);
  });

  test("a reply this version cannot read is an error, not a status", async () => {
    await expect(run(["status"], { v: 2 })).rejects.toThrow("cannot read");
  });

  test("without a running host it says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dh-mesh-"));
    try {
      await expect(meshCommand(["status", "--state-dir", dir], () => {})).rejects.toThrow(
        "no doriface-host is running",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
