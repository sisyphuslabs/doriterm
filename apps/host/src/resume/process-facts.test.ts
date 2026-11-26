import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { descends, processFacts } from "./process-facts.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "resume-facts-")));
const children: { kill(): void }[] = [];
afterAll(() => {
  for (const child of children) child.kill();
  rmSync(scratch, { recursive: true, force: true });
});

/** A shell in `cwd` that starts a sleeping child, and both pids once the child is up. */
async function family(cwd: string): Promise<{ readonly parent: number; readonly child: number }> {
  const shell = Bun.spawn(["sh", "-c", "sleep 600 & echo $!; wait"], { cwd, stdout: "pipe" });
  children.push(shell);
  const reader = shell.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const child = Number(new TextDecoder().decode(value).trim());
  children.push({ kill: () => process.kill(child) });
  return { parent: shell.pid, child };
}

describe.skipIf(process.platform === "win32")("processFacts", () => {
  test("reads a live process's user, parent, start and working directory", async () => {
    const { parent, child } = await family(scratch);
    const facts = await processFacts(child);
    expect(facts).toMatchObject({ uid: process.getuid?.(), ppid: parent, cwd: scratch });
    expect(facts?.started).toEqual(expect.any(String));
    expect((await processFacts(child))?.started).toBe(facts?.started ?? "");
  });

  test("a process that has exited has no facts", async () => {
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    expect(await processFacts(gone.pid)).toBeUndefined();
  });

  test("descends answers for the process itself, its descendants, and nothing else", async () => {
    const { parent, child } = await family(scratch);
    expect(await descends(child, parent)).toBe(true);
    expect(await descends(parent, parent)).toBe(true);
    expect(await descends(parent, child)).toBe(false);
    expect(await descends(process.pid, parent)).toBe(false);
  });
});
