import { expect, test } from "bun:test";

const childSource = `
import { watchParentDeath } from ${JSON.stringify(new URL("./parent-death.ts", import.meta.url).pathname)};
const stop = watchParentDeath(() => {
  stop();
  process.kill(Number(process.env["HANDSHAKE_PID"]), "SIGUSR1");
  process.exit(0);
}, { intervalMs: 20 });
process.stdout.write("watching\\n");
`;

const parentSource = `
const child = Bun.spawn(["bun", "-e", ${JSON.stringify(childSource)}], { stdout: "inherit", stdin: "ignore" });
await child.exited;
`;

test("a process watching its parent exits once the parent is SIGKILLed", async () => {
  const handshake = new Promise<void>((resolve) => process.once("SIGUSR1", () => resolve()));
  const parent = Bun.spawn(["bun", "-e", parentSource], {
    env: { ...process.env, HANDSHAKE_PID: String(process.pid) },
    stdout: "pipe",
    stderr: "inherit",
    stdin: "ignore",
  });
  const text = new TextDecoder();
  let seen = "";
  for await (const chunk of parent.stdout) {
    seen += text.decode(chunk);
    if (seen.includes("watching")) break;
  }
  expect(seen).toContain("watching");

  parent.kill("SIGKILL");
  await parent.exited;

  const outcome = await Promise.race([
    handshake.then(() => "exited" as const),
    Bun.sleep(5_000).then(() => "timed-out" as const),
  ]);
  expect(outcome).toBe("exited");
}, 15_000);
