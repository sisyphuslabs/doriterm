import { HcRpcError, type Machine, type MachineView } from "@doriface/protocol";
import type { Clock } from "../clock.ts";
import type { HcMachines } from "../hc-machines.ts";

export const hcError = (kind: string, message = kind): HcRpcError =>
  new HcRpcError({ code: -32000, message, data: { kind } });

/** herdr's machine table in memory: every call is logged with its virtual time, and adds can be made to fail. */
export class FakeMachines implements HcMachines {
  readonly calls: string[] = [];
  readonly #clock: Clock;
  #machines: MachineView[] = [];
  /** Each add of a name fails with the next queued error, then succeeds. */
  readonly failAdds = new Map<string, HcRpcError[]>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  seed(machine: Partial<MachineView> & Pick<MachineView, "name" | "target">): void {
    this.#machines.push({
      host: machine.name,
      id: `core-${machine.name}`,
      state: "connected",
      version: "0",
      ...machine,
    });
  }

  /** The state an added line starts in: herdr often answers an add while the line still dials. */
  addState = "connected";
  #held: { readonly table: readonly MachineView[]; readonly resolve: (table: readonly MachineView[]) => void }[] = [];
  #holdNext = false;

  /** herdr's line for `name` moves to `state` with no call from this host, as a dial that finishes does. */
  setState(name: string, state: string): void {
    this.#machines = this.#machines.map((machine) => (machine.name === name ? { ...machine, state } : machine));
  }

  /** The next list call answers the table as it is now, but only once the returned function is called. */
  holdNextList(): () => void {
    this.#holdNext = true;
    return () => {
      for (const held of this.#held.splice(0)) held.resolve(held.table);
    };
  }

  /** Every list call from now on is never answered, as from a herdr that stopped answering. */
  stallLists = false;

  list(): Promise<readonly MachineView[]> {
    if (this.stallLists) return new Promise(() => {});
    const table = [...this.#machines];
    if (!this.#holdNext) return Promise.resolve(table);
    this.#holdNext = false;
    const { promise, resolve } = Promise.withResolvers<readonly MachineView[]>();
    this.#held.push({ table, resolve });
    return promise;
  }

  add(name: string, via: string): Promise<Machine> {
    this.#log(`add ${name}`);
    const failure = this.failAdds.get(name)?.shift();
    if (failure !== undefined) return Promise.reject(failure);
    const machine = { host: name, id: `core-${name}`, name, target: via, version: "0" };
    this.#machines.push({ ...machine, state: this.addState, via: true });
    return Promise.resolve(machine);
  }

  /** Each rm fails with the next queued error, then succeeds. */
  readonly failRms: HcRpcError[] = [];

  rm(name: string): Promise<void> {
    this.#log(`rm ${name}`);
    const failure = this.failRms.shift();
    if (failure !== undefined) return Promise.reject(failure);
    this.#machines = this.#machines.filter((machine) => machine.name !== name);
    return Promise.resolve();
  }

  rename(name: string, newName: string): Promise<void> {
    this.#log(`rename ${name} ${newName}`);
    this.#machines = this.#machines.map((machine) => (machine.name === name ? { ...machine, name: newName } : machine));
    return Promise.resolve();
  }

  /** Each restore fails with the next queued error, then succeeds. */
  readonly failRestores: HcRpcError[] = [];

  restore(machine: MachineView): Promise<void> {
    this.#log(`restore ${machine.name}`);
    const failure = this.failRestores.shift();
    if (failure !== undefined) return Promise.reject(failure);
    this.#machines.push({ ...machine });
    return Promise.resolve();
  }

  connect(name: string): Promise<MachineView> {
    this.#log(`connect ${name}`);
    const machine = this.#machines.find((entry) => entry.name === name);
    return machine === undefined ? Promise.reject(hcError("not_found")) : Promise.resolve(machine);
  }

  #log(call: string): void {
    this.calls.push(`${this.#clock.now()} ${call}`);
  }
}
