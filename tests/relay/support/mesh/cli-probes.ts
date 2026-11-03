import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Each mesh command the scenarios run, and the control operation it must send to the running host (section 10.1). */
const COMMANDS = [
  { command: "join", args: ["mesh", "pair", "--auto", "--no-qr"], op: "mesh-pair" },
  { command: "join", args: ["mesh", "join", "ABCD2345", "--fingerprint", "ABCD", "--yes"], op: "mesh-join" },
  { command: "status", args: ["mesh", "status", "--json"], op: "mesh-status" },
  { command: "revoke", args: ["mesh", "revoke", "probe", "--yes"], op: "mesh-revoke" },
  { command: "revoke", args: ["mesh", "revoke", "--compromised", "probe", "--yes"], op: "mesh-revoke" },
  { command: "rename", args: ["mesh", "rename", "probe", "probe2"], op: "mesh-rename" },
  { command: "leave", args: ["mesh", "leave"], op: "mesh-leave" },
] as const;

export type MeshCommand = (typeof COMMANDS)[number]["command"];

/** A valid-shaped hostId (26 base32 characters) no host has: the bridge probe asks for a line to it. */
const PROBE_HOST = "a".repeat(26);

const opOf = (line: string): string | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && "op" in value && typeof value.op === "string"
      ? value.op
      : undefined;
  } catch {
    return undefined;
  }
};

async function runCli(cli: string, args: readonly string[], stateDir: string): Promise<void> {
  const proc = Bun.spawn([process.execPath, cli, ...args, "--state-dir", stateDir], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

/** What one Unix-socket listener in a scratch state dir received as the first line of each connection. */
async function firstLines(
  socketName: string,
  reply: string,
  drive: (stateDir: string) => Promise<void>,
): Promise<readonly string[]> {
  const stateDir = mkdtempSync(join(tmpdir(), "mprobe-"));
  const lines: string[] = [];
  const listener = Bun.listen<{ text: string }>({
    unix: join(stateDir, socketName),
    socket: {
      open(socket) {
        socket.data = { text: "" };
      },
      data(socket, bytes) {
        socket.data.text += Buffer.from(bytes).toString("utf8");
        const end = socket.data.text.indexOf("\n");
        if (end < 0) return;
        lines.push(socket.data.text.slice(0, end));
        socket.end(reply);
      },
    },
  });
  try {
    await drive(stateDir);
    return lines;
  } finally {
    listener.stop(true);
    rmSync(stateDir, { recursive: true, force: true });
  }
}

/** For each mesh command, the invocations whose control operation never reached the host (empty: it works). */
export type CliProbe = Readonly<Record<MeshCommand, readonly string[]>>;

/**
 * Runs every mesh command against a control socket that answers `null`, and records the operations that reached it:
 * a command that parses its arguments and asks the running host is there, whatever it prints afterwards.
 */
export async function probeCli(cli: string): Promise<CliProbe> {
  const reached = await Promise.all(
    COMMANDS.map(async (command) => {
      const lines = await firstLines("host.sock", '{"ok":true,"result":null}\n', (dir) =>
        runCli(cli, command.args, dir),
      );
      return { command, ok: lines.map(opOf).includes(command.op) };
    }),
  );
  const missing = (name: MeshCommand): readonly string[] =>
    reached
      .filter((each) => each.command.command === name && !each.ok)
      .map((each) => each.command.args.slice(1).join(" "));
  return {
    join: missing("join"),
    status: missing("status"),
    revoke: missing("revoke"),
    rename: missing("rename"),
    leave: missing("leave"),
  };
}

/** `connect --mesh <hostId>` asks the running host for a line over `line.sock` with `{"v":1,"hostId"}` (section 7.2). */
export async function probeBridge(cli: string): Promise<boolean> {
  const lines = await firstLines("line.sock", '{"ok":false,"reason":"probe"}\n', (dir) =>
    runCli(cli, ["connect", "--mesh", PROBE_HOST], dir),
  );
  return lines.some((line) => line === JSON.stringify({ v: 1, hostId: PROBE_HOST }));
}
