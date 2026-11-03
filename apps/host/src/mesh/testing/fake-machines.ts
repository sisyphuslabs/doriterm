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

  list(): Promise<readonly MachineView[]> {
    return Promise.resolve([...this.#machines]);
  }

  add(name: string, via: string): Promise<Machine> {
    this.#log(`add ${name}`);
    const failure = this.failAdds.get(name)?.shift();
    if (failure !== undefined) return Promise.reject(failure);
    const machine = { host: name, id: `core-${name}`, name, target: via, version: "0" };
    this.#machines.push({ ...machine, state: "connected", via: true });
    return Promise.resolve(machine);
  }

  rm(name: string): Promise<void> {
    this.#log(`rm ${name}`);
    this.#machines = this.#machines.filter((machine) => machine.name !== name);
    return Promise.resolve();
  }

  rename(name: string, newName: string): Promise<void> {
    this.#log(`rename ${name} ${newName}`);
    this.#machines = this.#machines.map((machine) => (machine.name === name ? { ...machine, name: newName } : machine));
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
