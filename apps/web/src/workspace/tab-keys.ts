import type { MachineView } from "@doriface/protocol";

/** hc's permanent machine ids by the names this core gives them now, both ways, and this core's own id. */
export interface MachineIds {
  readonly byName: ReadonlyMap<string, string>;
  readonly byId: ReadonlyMap<string, string>;
  /** The permanent id of the core this page goes through; empty until its hello is known. */
  readonly core?: string;
}

export function machineIds(machines: readonly MachineView[], core = ""): MachineIds {
  return {
    byName: new Map(machines.map((machine) => [machine.name, machine.id])),
    byId: new Map(machines.map((machine) => [machine.id, machine.name])),
    core,
  };
}

const LOCAL = "local:";
const ID = "id:";
const NAME = "name:";

/**
 * What a tab remembers its terminal by, so it survives a machine rename: `t7` is `local:t7`, `rohan/t7` is
 * `id:<rohan's id>/t7`, or `name:rohan/t7` until machine.list has named the machine.
 */
export function tabKey(address: string, ids: MachineIds): string {
  const slash = address.indexOf("/");
  if (slash === -1) return LOCAL + address;
  const id = ids.byName.get(address.slice(0, slash));
  return id === undefined ? NAME + address : ID + id + address.slice(slash);
}

/**
 * A terminal key as it is kept across loads (#2537): `local:t7` names the core this page goes through, so it is kept as
 * `id:<that core's id>/t7`, and read back bare only through that core. Without the core's id it is kept as it is.
 */
export function storedTerminalKey(key: string, core: string): string {
  return core !== "" && key.startsWith(LOCAL) ? `${ID}${core}/${key.slice(LOCAL.length)}` : key;
}

export function terminalKeyOn(key: string, core: string): string {
  const own = `${ID}${core}/`;
  return core !== "" && key.startsWith(own) ? LOCAL + key.slice(own.length) : key;
}

/** The address the tab's terminal has now; undefined while its machine is not in the list. */
export function tabAddress(key: string, ids: MachineIds): string | undefined {
  if (key.startsWith(LOCAL)) return key.slice(LOCAL.length);
  if (key.startsWith(NAME)) return key.slice(NAME.length);
  const rest = key.slice(ID.length);
  const slash = rest.indexOf("/");
  const name = ids.byId.get(rest.slice(0, slash));
  return name === undefined ? undefined : name + rest.slice(slash);
}
