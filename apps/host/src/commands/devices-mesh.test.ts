import { signCard } from "@doriface/mesh";
import { afterEach, expect, test } from "bun:test";
import { listenControl } from "../control.ts";
import { DeviceStore } from "../state/devices.ts";
import { cardBody } from "../state/mesh.ts";
import { ownOf, removeSides, side } from "../testing/join-harness.ts";
import { noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { devicesCommand } from "./devices.ts";

afterEach(removeSides);

test.each([false, true])("unpair prints the mesh revoke alternative with running=%s", async (running) => {
  const a = side("alpha");
  const c = side("browser");
  a.mesh.found(a.m.identity, ownOf(a));
  new DeviceStore(a.dir).add(c.m.identity.noise.publicKey, "browser");
  const mesh = a.mesh.read()?.meshId ?? "";
  const card = signCard(
    cardBody(
      c.m.identity,
      {
        name: "browser",
        hcId: "",
        devicePub: noiseOf(c.m),
      },
      mesh,
      signPubOf(a.m),
      undefined,
      "client",
    ),
    c.m.identity.sign.secretKey,
  );
  a.mesh.sign(a.m.identity, (n, prev) => ({
    v: 2,
    mesh,
    by: signPubOf(a.m),
    n,
    prev,
    type: "admit",
    subject: { card },
  }));
  const listener = running ? listenControl(a.dir, async () => 0) : undefined;
  let text = "";
  try {
    expect(
      await devicesCommand(["revoke", noiseOf(c.m), "--state-dir", a.dir], (line) => {
        text += line;
      }),
    ).toBe(0);
    expect(text).toContain("doriface-host mesh revoke browser");
    expect(text).toContain("running and reachable");
    expect(new DeviceStore(a.dir).list()).toEqual([]);
    expect(a.mesh.read()?.records).toHaveLength(2);
  } finally {
    listener?.stop();
  }
});
