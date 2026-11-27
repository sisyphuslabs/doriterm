import { encodeRequest, isJsonObject, JsonRpcParseError, parseJsonRpc } from "@doriface/protocol";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Same shutdown bound as the web e2e machine core (#2525).
const CORE_EXIT_BOUND_MS = 20_000;

async function waitForCoreExit(pid: number): Promise<void> {
  const deadline = performance.now() + CORE_EXIT_BOUND_MS;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (Reflect.get(Object(error), "code") === "ESRCH") return;
      throw error;
    }
    if (performance.now() >= deadline) throw new Error(`scratch hc core ${pid} did not exit after server.stop`);
    // oxlint-disable-next-line no-await-in-loop -- the core is not our child; only its disappearance signals exit.
    await delay(25);
  }
}

/** A scratch hc session (own core, state and socket) so the launch test never touches a real one. */
export function scratchHcSession(hc = process.env["HC_BIN"]): {
  readonly env: Record<string, string>;
  dispose(): Promise<void>;
} {
  if (hc === undefined || hc === "") throw new Error("the launch test needs HC_BIN pointing at hc 0.1.22");
  const dir = mkdtempSync(join(tmpdir(), "dd-e2e-"));
  const name = `doriface-desktop-e2e-${process.pid}`;
  const env = {
    HC_BIN: hc,
    HC_SESSION: name,
    XDG_STATE_HOME: join(dir, "state"),
    XDG_RUNTIME_DIR: join(dir, "run"),
    HC_SOCKET: join(dir, "c.sock"),
  };
  // A neutral core name, so the status bar does not show this machine's name in screenshots.
  const coreDir = join(env.XDG_STATE_HOME, "herdr-core", name);
  mkdirSync(coreDir, { recursive: true });
  writeFileSync(
    join(coreDir, "core.json"),
    JSON.stringify({ id: crypto.randomUUID().replace(/-/g, ""), name: "studio" }),
  );
  const dispose = async (): Promise<void> => {
    const output = execFileSync(hc, ["connect", "--session", name], {
      env: { ...process.env, ...env },
      input: `${encodeRequest(1, "server.status")}\n${encodeRequest(2, "server.stop")}\n`,
      encoding: "utf8",
      timeout: CORE_EXIT_BOUND_MS,
    });
    // A line that is not JSON (hc's own words on a failed connect) is no reply and is passed over, as the web twin does.
    const replies = output
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [parseJsonRpc(line)];
        } catch (error) {
          if (error instanceof JsonRpcParseError) return [];
          throw error;
        }
      });
    const status = replies.find((reply) => reply.kind === "success" && reply.id === 1);
    const pid = status?.kind === "success" && isJsonObject(status.result) ? status.result["pid"] : undefined;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
      throw new Error(`the scratch core did not name its pid, so its exit cannot be awaited: ${output}`);
    if (!replies.some((reply) => reply.kind === "success" && reply.id === 2))
      throw new Error(`server.stop got no success reply from the scratch core: ${output}`);
    await waitForCoreExit(pid);
    rmSync(dir, { recursive: true, force: true });
  };
  return { env, dispose };
}
