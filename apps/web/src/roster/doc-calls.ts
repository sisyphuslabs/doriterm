import type { HcConnection } from "@doriface/client";
import { HcRpcError, type MachineView } from "@doriface/protocol";
import { type DocCalls, LAYOUT_DOC } from "@doriface/protocol/layout";
import { openingAttachesAnswered } from "../terminal/opening-attach.ts";
import { offlineReason } from "../workspace/machine-state.ts";

/** Documents use permanent ids; only the RPC address uses a name, which may change before the feed tells this page. */
export function docCalls(
  connection: Pick<HcConnection, "call">,
  machines: () => readonly MachineView[],
  name: string = LAYOUT_DOC,
): DocCalls {
  const addressed = async <T>(id: string | null, call: (on: string | null) => Promise<T>): Promise<T> => {
    const on = id === null ? null : machines().find((machine) => machine.id === id)?.name;
    if (on === undefined) throw new Error(`The layout cannot take changes now: ${offlineReason()}`);
    try {
      return await call(on);
    } catch (cause) {
      if (id === null || !(cause instanceof HcRpcError) || cause.kind !== "machine_unknown") throw cause;
      const listed = await connection.call("machine.list");
      const renamed = listed.machines.find((machine) => machine.id === id);
      if (renamed === undefined || renamed.name === on) throw cause;
      return call(renamed.name);
    }
  };
  return {
    get: (id) => addressed(id, (on) => connection.call("doc.get", on === null ? { name } : { name, on })),
    set: (id, value, version) =>
      addressed(id, async (on) => {
        await openingAttachesAnswered(connection, on);
        return connection.call("doc.set", on === null ? { name, value, version } : { name, on, value, version });
      }),
  };
}
