import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { BUDGET_REFUSAL } from "./line-grants.ts";
import { Reconciler } from "./reconciler.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { hostIdFor, localHost, recorded, startCore } from "./testing/hc-mesh.ts";
import { signalProcess } from "../testing/run-cores.ts";

/** Independent of the reaper's marks: count the real CLI processes for this test's unique state dir. */
async function bridges(stateDir: string): Promise<number[]> {
  const ps = Bun.spawn(["ps", "-A", "-o", "pid=,comm=,args="], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const text = await new Response(ps.stdout).text();
  if ((await ps.exited) !== 0) throw new Error("ps failed");
  return text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match?.[2] === "bun" &&
      match[3]?.includes("/apps/host/src/cli.ts connect --mesh") &&
      match[3]?.includes(stateDir)
      ? [Number(match[1])]
      : [];
  });
}

test.each([BUDGET_REFUSAL, "peer refused the hello"])(
  "failed real hc adds do not accumulate bridge children: %s (#1433)",
  async (reason) => {
    const local = localHost();
    const core = await startCore("retry-owner");
    const sockets = new Set<Socket>();
    // A real wire peer refuses hc's hello but holds the TCP-style read half open.
    // hc drops its probe child on that error; the bridge must be that child, not an orphan behind sh.
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => {
        socket.write('{"ok":true}\n');
        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: reason, data: { kind: "unreachable" } },
          })}\n`,
        );
      });
      socket.on("error", () => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(join(local.stateDir, "line.sock"), resolve));
    const clock = new FakeClock();
    const machines = recorded(core.control.machines);
    const reconcile = new Reconciler({
      machines,
      program: local.program,
      stateDir: local.stateDir,
      selfHostId: core.member.hostId,
      clock,
      log: () => {},
    });
    const other = { ...core.member, name: "peer", hostId: hostIdFor("peer"), hcId: "peer-core" };
    const view = { members: [core.member, other], revoked: [] };
    try {
      expect(await bridges(local.stateDir)).toEqual([]);
      const sample = async (): Promise<number> => {
        await reconcile.reconcile(view);
        return (await bridges(local.stateDir)).length;
      };
      const live = [await sample(), await sample(), await sample()];
      console.log(`RETRY_COUNTS reason=${reason} adds=${machines.calls.length} live=${live.join(",")}`);
      expect(live).toEqual([0, 0, 0]);
      expect(machines.calls).toEqual(["add peer"]);
      const retry = async (delay: number): Promise<void> => {
        await clock.advance(delay);
        await reconcile.idle();
        // Token-availability/presence notifications still drive budget retries, subject to the same deadline.
        if (reason === BUDGET_REFUSAL) await reconcile.budgetAvailable(other.hostId);
        expect(await bridges(local.stateDir)).toEqual([]);
      };
      await retry(30_000);
      await retry(60_000);
      expect(machines.calls).toEqual(["add peer", "add peer", "add peer"]);
      console.log(`RETRY_FINAL reason=${reason} adds=${machines.calls.length} live=0`);
    } finally {
      reconcile.stop();
      await core.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      for (const pid of await bridges(local.stateDir)) signalProcess(pid, "SIGKILL");
      local.dispose();
    }
  },
  60_000,
);
