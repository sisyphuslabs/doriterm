import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A scratch hc session (own core, state and socket) so the launch test never touches a real one. */
export function scratchHcSession(hc = process.env["HC_BIN"]): {
  readonly env: Record<string, string>;
  dispose(): Promise<void>;
} {
  if (hc === undefined || hc === "") throw new Error("the launch test needs HC_BIN pointing at hc 0.1.21");
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
    const control = spawn(hc, ["connect", "--session", name], { env: { ...process.env, ...env } });
    const exited = new Promise<void>((resolve) => control.once("exit", () => resolve()));
    const replied = new Promise<void>((resolve, reject) => {
      control.stdout.once("data", () => resolve());
      control.once("error", reject);
      exited.then(() => reject(new Error("hc connect exited before answering server.stop")), reject);
    });
    try {
      control.stdin.write('{"jsonrpc":"2.0","id":1,"method":"server.stop"}\n');
      await replied;
      control.stdin.end();
      await exited;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return { env, dispose };
}
