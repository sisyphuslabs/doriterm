import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signalProcess } from "./run-cores.ts";

test("the connect --mesh helper leaves zero live CLI children when its test finishes (#1433)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "bridge-"));
  const sockets = new Set<Socket>();
  const accepted = Promise.withResolvers<void>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => {
      socket.write('{"ok":true}\n');
      accepted.resolve();
    });
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(join(stateDir, "line.sock"), resolve));
  // No bunfig in this cwd: this proves the spawning helper owns its child even without the suite guard.
  const suite = Bun.spawn([process.execPath, "test", "--timeout", "10000", "./testing/leak-bridge.fixture.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, BRIDGE_STATE: stateDir },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let left: number[] = [];
  try {
    await accepted.promise;
    suite.stdin.write("ready");
    await suite.stdin.flush();
    await suite.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(suite.stdout).text(),
      new Response(suite.stderr).text(),
      suite.exited,
    ]);
    expect(code, stdout + stderr).toBe(0);
    const ps = Bun.spawn(["ps", "-A", "-o", "pid=,comm=,args="], {
      env: process.env,
      stdout: "pipe",
      stderr: "inherit",
    });
    const text = await new Response(ps.stdout).text();
    expect(await ps.exited).toBe(0);
    left = text.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      return match?.[2] === "bun" &&
        match[3]?.includes("/apps/host/src/cli.ts connect --mesh") &&
        match[3]?.includes(stateDir)
        ? [Number(match[1])]
        : [];
    });
    console.log(`BRIDGE_AFTER_SUITE=${left.length}`);
    expect(left).toEqual([]);
  } finally {
    suite.kill("SIGKILL");
    await suite.exited;
    for (const pid of left) signalProcess(pid, "SIGKILL");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 30_000);
