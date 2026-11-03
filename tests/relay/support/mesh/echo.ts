import { inOrder } from "../sequential.ts";
import type { Mesh } from "./mesh.ts";

export interface Echo {
  readonly from: string;
  readonly to: string;
  readonly nonce: string;
  /** The nonce came back, and the process that echoed it ran in the target's own hc session. */
  readonly ok: boolean;
  /** Bytes moved through both hosts' relay taps during the call; undefined when there are no taps (production). */
  readonly relayBytes: number | undefined;
}

const decode = (base64: string): string => Buffer.from(base64, "base64").toString("utf8");

/** Every ordered pair of the given hosts. */
export const directedPairs = (names: readonly string[]): readonly (readonly [string, string])[] =>
  names.flatMap((from) => names.filter((to) => to !== from).map((to): readonly [string, string] => [from, to]));

/**
 * One directed check: `from`'s core runs a shell line on `to` through the machine hc added for it, and the line
 * prints a fresh nonce and the hc session it runs in. Seeing the target's own session name proves where it ran.
 */
export async function echo(mesh: Mesh, from: string, to: string): Promise<Echo> {
  const source = await mesh.core(from);
  const target = await mesh.core(to);
  const added = (await source.call("machine.list")).machines.find((machine) => machine.id === target.hello.core.id);
  if (added === undefined) throw new Error(`${from}'s core has no machine for ${to}`);
  const taps = [mesh.host(from).tap, mesh.host(to).tap];
  const before = taps.map((tap) => tap?.bytes() ?? 0);
  const nonce = crypto.randomUUID();
  const result = await source.call("machine.exec", { on: added.name, line: `echo ${nonce}; echo $HC_SESSION` });
  const [printed, session] = decode(result.stdout).split("\n");
  const moved = taps.map((tap, index) => (tap?.bytes() ?? 0) - (before[index] ?? 0));
  return {
    from,
    to,
    nonce,
    ok: result.code === 0 && printed === nonce && session === mesh.host(to).session.name,
    relayBytes: taps.every((tap) => tap !== undefined) ? Math.min(...moved) : undefined,
  };
}

/** Runs every directed pair one after another, so each pair's relay bytes are its own. */
export async function echoAll(mesh: Mesh, names: readonly string[]): Promise<readonly Echo[]> {
  return inOrder(directedPairs(names), ([from, to]) => echo(mesh, from, to));
}

/** Waits until every host's core lists every other host as a connected machine, which is the mesh converged. */
export async function untilFullMesh(mesh: Mesh, names: readonly string[]): Promise<void> {
  await mesh.until(`every one of ${names.length} hosts lists the other ${names.length - 1} as connected`, async () => {
    const lists = await Promise.all(
      names.map(async (name) => (await (await mesh.core(name)).call("machine.list")).machines),
    );
    return lists.every(
      (machines) => machines.filter((machine) => machine.state === "connected").length === names.length - 1,
    );
  });
}
