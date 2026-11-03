import { type Mesh } from "./mesh.ts";
import { machineIds, viewOf } from "./status.ts";

/** Resolves once none of `gone` is in the view or the core's machine list of any of `watchers`. */
export async function untilGone(mesh: Mesh, watchers: readonly string[], gone: readonly string[]): Promise<void> {
  const ids = gone.map((name) => mesh.host(name).hostId);
  const coreIds = await Promise.all(gone.map(async (name) => (await mesh.core(name)).hello.core.id));
  await mesh.until(`${gone.join(", ")} gone from ${watchers.join(", ")}`, async () => {
    const seen = await Promise.all(
      watchers.map(async (name) => [
        (await viewOf(mesh.host(name))).map((member) => member.hostId),
        await machineIds(mesh, name),
      ]),
    );
    return seen.every(
      ([view, machines]) => !ids.some((id) => view?.includes(id)) && !coreIds.some((id) => machines?.includes(id)),
    );
  });
}
