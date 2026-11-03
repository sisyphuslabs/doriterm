import type { Mesh } from "./mesh.ts";
import type { MeshHost } from "./mesh-host.ts";

/** An injection's two ends: the member whose keys open the session, and the host that judges what it carries. */
export interface Pair {
  readonly carrier: MeshHost;
  readonly target: MeshHost;
}

const tapOf = (host: MeshHost) => {
  if (host.tap === undefined) throw new Error(`${host.name} has no relay tap to isolate`);
  return host.tap;
};

/**
 * Makes each injected session the only sync session its pair can have. Section 5.1 keeps one session per pair: the
 * one dialed by the smaller hostId, or the newer one from the same dialer. A session the carrier's own running host
 * or the target dialed may already be up (one lingers 60 s after its last line), and when the target dialed it and
 * has the smaller hostId, the target keeps it and closes the injected one with 1000 before reading a line.
 *
 * So both hosts' taps refuse (and close) their dials to each other, uplinks kept, and this waits until neither tap
 * holds such a connection. No session between the pair is then up, none can be dialed, and the injected session,
 * which reaches the relay directly, is the one the target keeps. The returned function lifts the blocks.
 */
export async function isolate(mesh: Mesh, pairs: readonly Pair[]): Promise<() => void> {
  const blocked = new Map<MeshHost, Set<string>>();
  const block = (from: MeshHost, to: MeshHost): void => {
    const set = blocked.get(from) ?? new Set<string>();
    set.add(to.hostId);
    blocked.set(from, set);
  };
  for (const { carrier, target } of pairs) {
    block(carrier, target);
    block(target, carrier);
  }
  for (const [host, hostIds] of blocked) tapOf(host).block([...hostIds]);
  const heal = (): void => {
    for (const host of blocked.keys()) tapOf(host).heal();
  };
  try {
    const names = pairs.map(({ carrier, target }) => `${carrier.name}-${target.name}`).join(", ");
    await mesh.until(`no sync session is up between ${names}`, () =>
      pairs.every(
        ({ carrier, target }) => tapOf(carrier).openTo(target.hostId) + tapOf(target).openTo(carrier.hostId) === 0,
      ),
    );
  } catch (error) {
    heal();
    throw error;
  }
  return heal;
}
