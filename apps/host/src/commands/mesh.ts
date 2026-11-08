import { parseMeshStatus } from "@doriface/protocol";
import { parseArgs } from "node:util";
import { requestControl } from "../control.ts";
import { confirmOnTerminal, leaveMesh, renameMember, revokeMember } from "./mesh-change.ts";
import { formatMeshStatus } from "../mesh/status-text.ts";
import { defaultStateDir } from "../state/files.ts";
import { printable } from "./devices.ts";

export const MESH_USAGE = `usage: doriface-host mesh status [--json] [--state-dir <dir>]
       doriface-host mesh revoke [--compromised] [--yes] <member> [--state-dir <dir>]
       doriface-host mesh rename <member> <name> [--state-dir <dir>]
       doriface-host mesh leave [--yes] [--state-dir <dir>]

  status asks the running host on the state dir: line states, presence and the dial budget live only there
  revoke signs a revoke of <member> (its mesh name or hostId); --compromised also names every member it admitted
  rename signs a new mesh name for <member>; leave signs a revoke of this host, pushes it, then deletes mesh.json
  --yes  write a revoke that asks first (--compromised, or one no other member could witness)`;

/** `mesh status|revoke|rename|leave`. Returns the exit code: 1 when the host is in no mesh. */
export async function meshCommand(
  args: readonly string[],
  out: (text: string) => void,
  confirm: (question: string) => Promise<boolean> = confirmOnTerminal,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      compromised: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      "state-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    out(`${MESH_USAGE}\n`);
    return 0;
  }
  const stateDir = values["state-dir"] ?? defaultStateDir();
  const [command, ...rest] = positionals;
  const context = { stateDir, out, confirm };
  if (command === "revoke") {
    if (rest.length !== 1 || rest[0] === undefined) throw new Error("mesh revoke needs one member");
    return revokeMember(context, rest[0], values.compromised, values.yes);
  }
  if (command === "rename") {
    if (rest.length !== 2 || rest[0] === undefined || rest[1] === undefined) {
      throw new Error("mesh rename needs a member and its new name");
    }
    return renameMember(context, rest[0], rest[1]);
  }
  if (command === "leave" && rest.length === 0) return leaveMesh(context, values.yes);
  if (command !== "status" || rest.length !== 0) throw new Error(`unknown mesh command: ${positionals.join(" ")}`);
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
