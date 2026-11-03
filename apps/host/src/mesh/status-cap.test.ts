// mesh status over PR 2's real view: a mesh one key past the 12-member cap, built from signed records through viewOf.
import { base64urlEncode, type HostIdentity, hostIdentityFromSecrets } from "@doriface/crypto";
import { hashOf, MAX_MESH_MEMBERS, meshIdOf, type Signed, signCard, signRecord, viewOf } from "@doriface/mesh";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meshCommand } from "../commands/mesh.ts";
import { listenControl } from "../control.ts";
import { meshFixture } from "../testing/mesh-fixture.ts";
import type { MeshSources } from "./status-sources.ts";
import { meshStatus } from "./status.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const seed = (label: string): Uint8Array =>
  new Uint8Array(new Bun.CryptoHasher("sha256").update(`doriface mesh cap ${label}`).digest());
const keyOf = (id: HostIdentity): string => base64urlEncode(id.sign.publicKey);

const nameAt = (index: number): string => `box-${String(index + 1).padStart(2, "0")}`;
const founder = hostIdentityFromSecrets(seed("box-01 sign"), seed("box-01 noise"));
const joiners = Array.from({ length: MAX_MESH_MEMBERS }, (_, at) =>
  hostIdentityFromSecrets(seed(`${nameAt(at + 1)} sign`), seed(`${nameAt(at + 1)} noise`)),
);
const ids = [founder, ...joiners];

/** The founder admits every other key in one chain, so the thirteenth admission lands past the cap. */
function capRecords(): readonly Signed[] {
  const records: Signed[] = [];
  let mesh = "-";
  for (const [at, id] of ids.entries()) {
    const card = signCard(
      {
        v: 1,
        mesh,
        inviter: at === 0 ? "-" : keyOf(founder),
        nonce: base64urlEncode(seed(`${nameAt(at)} nonce`).subarray(0, 16)),
        hostId: id.hostId,
        signPub: keyOf(id),
        noisePub: base64urlEncode(id.noise.publicKey),
        name: nameAt(at),
        hcId: `core-${nameAt(at)}`,
      },
      id.sign.secretKey,
    );
    const last = records.at(-1);
    const record = signRecord(
      {
        v: 2,
        mesh,
        type: at === 0 ? "found" : "admit",
        by: keyOf(founder),
        n: at + 1,
        prev: last === undefined ? [] : [hashOf(last)],
        subject: { card },
      },
      founder.sign.secretKey,
    );
    if (at === 0) mesh = meshIdOf(record);
    records.push(record);
  }
  return records;
}

const records = capRecords();
const found = records[0];
const view = viewOf(records);
const base = meshFixture(NOW).sources;
const sources: MeshSources = {
  ...base,
  view,
  revocations: new Map(),
  failClosed: [],
  local: {
    ...base.local,
    meshId: found === undefined ? "" : meshIdOf(found),
    self: keyOf(founder),
    localNames: new Map(),
    noticed: new Map(),
  },
  pending: [],
  peers: new Map(),
  lines: new Map(),
  witnessPool: () => ({ pool: [keyOf(founder)], ask: null }),
};
const over = ids[MAX_MESH_MEMBERS];

async function statusText(answer: unknown): Promise<{ code: number; text: string }> {
  const dir = mkdtempSync(join(tmpdir(), "dh-mesh-cap-"));
  const control = listenControl(dir, async () => answer);
  let text = "";
  try {
    const code = await meshCommand(["status", "--state-dir", dir], (chunk) => {
      text += chunk;
    });
    return { code, text };
  } finally {
    control.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("mesh status of a mesh past the 12-member cap, from PR 2's viewOf", () => {
  test("lists the over-cap key last with its lineage, and no name or key the view does not give it", () => {
    expect([view.members.size, [...view.overCap]]).toEqual([MAX_MESH_MEMBERS, [over === undefined ? "" : keyOf(over)]]);
    const status = meshStatus(sources, NOW);
    expect(status.members.map((member) => [member.hostId, member.overCap])).toEqual(
      ids.map((id, at) => [id.hostId, at === MAX_MESH_MEMBERS]),
    );
    expect(status.members.at(-1)).toMatchObject({
      name: null,
      localName: null,
      fingerprint: null,
      admittedBy: founder.hostId,
    });
    expect(status.members[0]).toMatchObject({ hostId: founder.hostId, name: "box-01", line: "self", admittedBy: null });
    expect(status.members[1]?.admittedBy).toBe(founder.hostId);
    expect(status.members.slice(0, MAX_MESH_MEMBERS).map((member) => member.name)).toEqual(
      ids.slice(0, MAX_MESH_MEMBERS).map((_, at) => nameAt(at)),
    );
  });

  test("mesh status prints the founder as the founder, and the over-cap member by its hostId with its admitter", async () => {
    const { code, text } = await statusText(meshStatus(sources, NOW));
    expect(code).toBe(0);
    const lines = text.split("\n");
    const self = lines.findIndex((line) => line.startsWith(`  box-01 ${founder.hostId} `));
    expect(lines[self + 1]).toBe("    this host, founder");
    const at = lines.indexOf(`  ${over?.hostId}`);
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe("    absent, admitted by box-01, over the 12-member cap");
  });
});
