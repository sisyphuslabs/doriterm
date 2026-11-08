// Explicit-path fixture for test-run.hc.test.ts; the two children are bounded even if the guard regresses.
import { expect, test } from "bun:test";

test("leave a child and grandchild for the suite guard", async () => {
  const grandchild = "setTimeout(() => {}, 30_000)";
  const script = `
    import { closeSync } from "node:fs";
    const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(grandchild)}], {
      env: process.env, stdio: ["ignore", "ignore", "ignore"]
    });
    console.log(JSON.stringify([process.pid, child.pid]));
    closeSync(1);
    await child.exited;
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });
  const reader = child.stdout.getReader();
  const line = new TextDecoder().decode((await reader.read()).value).trim();
  reader.releaseLock();
  child.unref();
  console.log(`LEFT_TREE ${line}`);
  expect(JSON.parse(line)).toHaveLength(2);
});
