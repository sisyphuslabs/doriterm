import { afterAll, describe, expect, test } from "bun:test";
import { type ByteLink, SecureLinkError } from "@doriface/crypto";
import { DialPolicy } from "./dial-policy.ts";
import { MeshDriver } from "./driver.ts";
import { MeshLines } from "./mesh-lines.ts";
import { Reconciler } from "./reconciler.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { type Core, dialCore, localHost, startCore } from "./testing/hc-mesh.ts";
import type { MeshMember, MeshView } from "./upstream.ts";

const started: Core[] = [];
const locals: ReturnType<typeof localHost>[] = [];
afterAll(async () => {
  for (const local of locals) local.dispose();
  await Promise.all(started.map((core) => core.dispose()));
});

/** This host and member x on real cores; x's relay hop answers 4404 until `online` is set. */
async function offlineMember() {
  const [self, x] = await Promise.all(["self", "x"].map(startCore));
  if (self === undefined || x === undefined) throw new Error("cores");
  started.push(self, x);
  const local = localHost();
  locals.push(local);
  const clock = new FakeClock();
  const reach = { online: false };
  const policy = new DialPolicy({ clock, random: seededRandom(13), onDue: () => undefined });
  const view: MeshView = { members: [self.member, x.member], overCap: [], revoked: [] };
  const toCore = dialCore([x]);
  const dial = (member: MeshMember): Promise<ByteLink> =>
    reach.online ? toCore(member) : Promise.reject(new SecureLinkError(4404, "host is not connected (4404)"));
  const lines = new MeshLines({ view: () => view, policy, dial });
  local.serve(lines);
  const reconciler = new Reconciler({
    machines: self.control.machines,
    program: local.program,
    stateDir: local.stateDir,
    selfHostId: self.member.hostId,
    clock,
    log: () => undefined,
  });
  const driver = new MeshDriver({ reconciler, lines, policy, view });
  await driver.start();
  await reconciler.idle();
  const names = async (): Promise<readonly string[]> => (await self.control.machines.list()).map((m) => m.name);
  return { x, clock, reach, policy, reconciler, driver, names };
}

describe("a member offline when the reconciler ran is added once it is back (H-54-1, real hc)", () => {
  test("on its presence", async () => {
    const { x, reach, policy, reconciler, driver, names } = await offlineMember();
    expect(reconciler.status.get(x.member.hostId)?.state).toBe("retrying");
    expect(await names()).toEqual([]);
    reach.online = true;
    policy.presence(x.member.signPub);
    await driver.due(x.member.signPub, "presence");
    await reconciler.idle();
    expect(await names()).toEqual(["x"]);
    expect(reconciler.status.get(x.member.hostId)?.state).toBe("ok");
  }, 90_000);

  test("with no presence, on the 30 s retry, which goes as the member's due probe", async () => {
    const { clock, reach, reconciler, names } = await offlineMember();
    expect(await names()).toEqual([]);
    reach.online = true;
    await clock.advance(29_999);
    await reconciler.idle();
    expect(await names()).toEqual([]);
    await clock.advance(1);
    await reconciler.idle();
    expect(await names()).toEqual(["x"]);
  }, 90_000);
});
