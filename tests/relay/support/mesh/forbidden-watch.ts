import { coalesce, type Mesh } from "./mesh.ts";

/** Keys that must never reach an honest host: a minted key, or a revoked one. */
export interface Forbidden {
  readonly hostIds: readonly string[];
  /** Core ids (`hcId` in their cards): what a machine for them would be listed as. */
  readonly coreIds: readonly string[];
}

export interface ForbiddenWatch {
  /** Takes a last look and returns every sighting since the watch began; empty when none was ever seen. */
  stop(): Promise<readonly string[]>;
}

/**
 * Watches `watchers` for the whole window, not just at its end. On every host log line, core event and tap change it
 * lists each watcher's machines; at the end it also reads every dial the watchers made through their taps and every
 * log line they wrote. A forbidden key in any of them is a sighting.
 */
export function watchForbidden(mesh: Mesh, watchers: readonly string[], forbidden: Forbidden): ForbiddenWatch {
  const sightings = new Set<string>();
  const logStart = new Map(watchers.map((name) => [name, mesh.host(name).logs.length]));
  const dialStart = new Map(watchers.map((name) => [name, mesh.host(name).tap?.dials().length ?? 0]));
  const look = async (): Promise<void> => {
    await Promise.all(
      watchers.map(async (name) => {
        const { machines } = await (await mesh.core(name)).call("machine.list");
        for (const machine of machines) {
          if (forbidden.coreIds.includes(machine.id))
            sightings.add(`${name} lists machine ${machine.name} (${machine.id})`);
        }
      }),
    );
  };
  let failure: unknown;
  const wake = coalesce(look, (error: unknown) => {
    failure ??= error;
  });
  const off = mesh.onWake(wake);
  wake();
  return {
    async stop() {
      off();
      await look();
      if (failure !== undefined) throw failure;
      for (const name of watchers) {
        const host = mesh.host(name);
        const dials = host.tap?.dials().slice(dialStart.get(name) ?? 0) ?? [];
        for (const target of dials) if (forbidden.hostIds.includes(target)) sightings.add(`${name} dialed ${target}`);
        const lines = host.logs.slice(logStart.get(name) ?? 0);
        for (const line of lines) {
          const key = [...forbidden.hostIds, ...forbidden.coreIds].find((id) => line.includes(id));
          if (key !== undefined) sightings.add(`${name} logged ${key}: ${line}`);
        }
      }
      return [...sightings];
    },
  };
}
