import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { createHcSession } from "./hc-session.ts";
import { ownMeshSession } from "./mesh-session.ts";
import { RUN_MARK, runProcesses, stopRunProcesses } from "./run-cores.ts";

test("a mesh session's dispose leaves no process of a persistent terminal running", async () => {
  const mark = crypto.randomUUID();
  const scratch = createHcSession("mesh-holder", { [RUN_MARK]: mark });
  const socket = scratch.env["HC_SOCKET"];
  if (socket === undefined) throw new Error("mesh session has no socket");
  const run = { mark, dir: dirname(socket) };
  const session = await ownMeshSession(scratch);
  try {
    // A persistent terminal, as the browser fixture's on-b: hc gives it a holder of its own (setsid), outside the core's
    // group, and a SIGTERM to the core hands the terminal over to that holder, which then starts a new core.
    const started = Bun.spawn([session.hc, "run", "--bg", "--name", "on-b", "--", "sh"], {
      env: session.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [error, code] = await Promise.all([new Response(started.stderr).text(), started.exited]);
    expect(code, error).toBe(0);
    const held = await runProcesses(run);
    expect(held.filter((one) => one.command.includes(" hold --socket ")).length, "the terminal has no holder").toBe(1);
    // A dispose that had to stop processes itself rejects with their count: the clean stop missed them.
    const stopped = await session.dispose().then(
      () => "",
      (reason: unknown) => String(reason),
    );
    const left = await runProcesses(run);
    console.log(`MESH_SESSION_LEFTOVERS=${left.length}`);
    const named = left.map(({ pid, command, where }) => `pid ${pid}: ${command} (${where})`);
    expect(left.length, `${left.length} processes outlived the dispose:\n${named.join("\n")}`).toBe(0);
    expect(stopped).toBe("");
  } finally {
    await stopRunProcesses(run);
  }
}, 60_000);
