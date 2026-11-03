import { parseMeshStatus } from "@doriface/protocol";
import { parseArgs } from "node:util";
import { requestControl } from "../control.ts";
import { formatMeshStatus } from "../mesh/status-text.ts";
import { defaultStateDir } from "../state/files.ts";
import { printable } from "./devices.ts";

export const MESH_USAGE = `usage: doriface-host mesh status [--json] [--state-dir <dir>]

  status asks the running host on the state dir: line states, presence and the dial budget live only there`;

/** `mesh status [--json]`. Returns the exit code: 0 with a status, 1 when the host is in no mesh. */
export async function meshCommand(args: readonly string[], out: (text: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      "state-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    out(`${MESH_USAGE}\n`);
    return 0;
  }
  if (positionals.length !== 1 || positionals[0] !== "status") {
    throw new Error(`unknown mesh command: ${positionals.join(" ")}`);
  }
  const stateDir = values["state-dir"] ?? defaultStateDir();
  const reply = await requestControl(stateDir, { op: "mesh-status" });
  if (reply === undefined) throw new Error(`no doriface-host is running on ${stateDir}`);
  if (reply === null) {
    out("this host is in no mesh\n");
    return 1;
  }
  const status = parseMeshStatus(reply);
  if (status === undefined) throw new Error("the running host answered with a status this version cannot read");
  if (values.json) out(`${JSON.stringify(status, null, 2)}\n`);
  else out(`${formatMeshStatus(status).trimEnd().split("\n").map(printable).join("\n")}\n`);
  return 0;
}
