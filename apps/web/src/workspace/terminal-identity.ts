import type { MachineView } from "@doriface/protocol";

/**
 * One terminal however this page reaches it (#2288): the core that runs it, by its permanent id, and its id on that core.
 * Through core A a terminal on machine B is `B/t7`; reached as its own connection it is `t7`. Both are this identity.
 */
export interface TerminalIdentity {
  readonly core: string;
  readonly terminal: string;
}

/** A route to terminals: the core this page is connected to, and the machines it reaches (machine.list: name, id). */
export interface TerminalRoute {
  readonly core: string;
  readonly machines: readonly Pick<MachineView, "name" | "id">[];
}

/**
 * The identity behind an address on `route`: a bare address is the connected core's, `name/id` an added machine's,
 * found by its name on this route (a fallback name included). Undefined for a machine this route does not list.
 */
export function identityOf(address: string, route: TerminalRoute): TerminalIdentity | undefined {
  const at = address.indexOf("/");
  if (at < 0) return { core: route.core, terminal: address };
  const name = address.slice(0, at);
  const machine = route.machines.find((each) => each.name === name);
  return machine === undefined ? undefined : { core: machine.id, terminal: address.slice(at + 1) };
}

/** The address `identity` has on `route`; undefined when this route does not reach its core. */
export function addressOf(identity: TerminalIdentity, route: TerminalRoute): string | undefined {
  if (identity.core === route.core) return identity.terminal;
  const machine = route.machines.find((each) => each.id === identity.core);
  return machine === undefined ? undefined : `${machine.name}/${identity.terminal}`;
}
