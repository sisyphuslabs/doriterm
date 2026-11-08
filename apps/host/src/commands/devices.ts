import { parseArgs } from "node:util";
import { requestControl } from "../control.ts";
import { deviceIdOf, DeviceStore, type PairedDevice } from "../state/devices.ts";
import { defaultStateDir } from "../state/files.ts";
import { MeshStore } from "../state/mesh.ts";
import { meshRevokeCommand } from "@doriface/protocol";

export const DEVICES_USAGE = `usage: doriface-host devices list [--state-dir <dir>]
       doriface-host devices revoke <id> [--state-dir <dir>]

  revoke removes the device; a running host on the same state dir closes its live sessions (close code 4401)`;

/** Escapes control, format and line-separator characters, so a hand-edited name cannot rewrite the terminal. */
export const printable = (name: string): string =>
  name.replaceAll(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );

const line = (device: PairedDevice, ...fields: readonly string[]): string =>
  `${[deviceIdOf(device), ...fields, device.name].map(printable).join("  ")}\n`;

/** `devices list` prints one device per line; `devices revoke <id>` removes one. Returns the exit code. */
export async function devicesCommand(args: readonly string[], out: (text: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: { "state-dir": { type: "string" }, help: { type: "boolean", short: "h", default: false } },
  });
  if (values.help) {
    out(`${DEVICES_USAGE}\n`);
    return 0;
  }
  const [action, handle, ...extra] = positionals;
  const listing = action === "list" && handle === undefined;
  const revoking = action === "revoke" && handle !== undefined && extra.length === 0;
  if (!listing && !revoking) throw new Error(`unknown devices command: ${positionals.join(" ")}`);
  const stateDir = values["state-dir"] ?? defaultStateDir();
  const store = new DeviceStore(stateDir);
  if (listing) {
    const devices = store.list();
    if (devices.length === 0) out("no paired devices\n");
    for (const device of devices) out(line(device, device.pairedAt));
    return 0;
  }
  const removed = store.revoke(handle ?? "");
  if (removed.length === 0) throw new Error(`no paired device has the id ${JSON.stringify(handle)}`);
  const index = new MeshStore(stateDir, { log: (message) => out(`${printable(message)}\n`) }).authorizeIndex();
  for (const device of removed) {
    const client = index?.client(device.clientStaticPub);
    if (client !== undefined) {
      const command = meshRevokeCommand(client.name);
      out(
        `Mesh membership ends when the admitting host is running and reachable. To end it now, run ${printable(command ?? `doriface-host mesh revoke ${client.hostId}`)} on any running member.\n`,
      );
    }
  }
  await requestControl(stateDir, { op: "devices-changed" });
  for (const device of removed) out(`revoked ${line(device)}`);
  return 0;
}
