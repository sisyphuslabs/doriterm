// A mesh with one member in every state the status shows, keyed by real host identities derived from fixed seeds so
// hostIds and fingerprints are the same on every run (tests and screenshot captures depend on that).
import { base64urlEncode, type HostIdentity, hostIdentityFromSecrets } from "@doriface/crypto";
import type { LineFacts, MeshSources, PeerFacts } from "../mesh/status-sources.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const seed = (label: string): Uint8Array =>
  new Uint8Array(new Bun.CryptoHasher("sha256").update(`doriface mesh fixture ${label}`).digest());

const identity = (name: string): HostIdentity => hostIdentityFromSecrets(seed(`${name} sign`), seed(`${name} noise`));

export const FIXTURE_NAMES = ["studio", "build-box", "laptop", "tablet", "kiosk", "spare", "ci-runner"] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export interface MeshFixture {
  readonly sources: MeshSources;
  readonly ids: Readonly<Record<FixtureName, HostIdentity>>;
  /** Signing key (base64url) per name. */
  readonly keys: Readonly<Record<FixtureName, string>>;
}

function recordOf<T>(make: (name: FixtureName) => T): Record<FixtureName, T> {
  return {
    studio: make("studio"),
    "build-box": make("build-box"),
    laptop: make("laptop"),
    tablet: make("tablet"),
    kiosk: make("kiosk"),
    spare: make("spare"),
    "ci-runner": make("ci-runner"),
  };
}

const line: LineFacts = { state: "absent", reason: null, stuck: null, helloCoreId: null, replaced: null };
const idle: PeerFacts = { presence: false, lastSync: null, owed: 0, gate: null, unreachableSince: null };

/**
 * studio is this host and the founder. build-box is online, laptop has been unreachable for 9 days, tablet joined a day
 * ago through build-box, kiosk was revoked as compromised and its backdated revoke removed spare (fail closed), and
 * ci-runner waits for approval.
 */
export function meshFixture(now: Date): MeshFixture {
  const ids = recordOf(identity);
  const keys = recordOf((name) => base64urlEncode(ids[name].sign.publicKey));
  const key = (name: FixtureName): string => keys[name];
  const noise = (name: FixtureName): string => base64urlEncode(ids[name].noise.publicKey);
  const members: readonly FixtureName[] = ["studio", "build-box", "laptop", "tablet"];
  const ago = (ms: number): Date => new Date(now.getTime() - ms);
  const sources: MeshSources = {
    view: {
      members: new Set(members.map(key)),
      revoked: new Set([key("kiosk"), key("spare")]),
      noise: new Map(members.map((name) => [key(name), noise(name)])),
      admitter: new Map([
        [key("studio"), key("studio")],
        [key("build-box"), key("studio")],
        [key("laptop"), key("studio")],
        [key("tablet"), key("build-box")],
      ]),
      name: new Map(members.map((name) => [key(name), name])),
    },
    revocations: new Map([
      [key("kiosk"), { name: "kiosk", noisePub: noise("kiosk"), by: [key("studio")], reason: "compromised", at: null }],
      [key("spare"), { name: "spare", noisePub: noise("spare"), by: [key("kiosk")], reason: "revoke", at: null }],
    ]),
    failClosed: [{ removed: [key("spare")], revokedKey: key("kiosk") }],
    local: {
      meshId: "q7m2k4xw2d3b5n6r6t7v3c2z4a",
      self: key("studio"),
      generation: 41,
      records: 23,
      counter: { file: 7, mesh: 7 },
      localNames: new Map(),
      noticed: new Map([[key("tablet"), ago(DAY)]]),
      readOnlyUntil: null,
      possiblyRevoked: false,
    },
    pending: [
      {
        nonce: "dGhlIGpvaW5lcidzIG5vbmNl",
        name: "ci-runner",
        hostId: ids["ci-runner"].hostId,
        noisePub: noise("ci-runner"),
        expiresAt: new Date(now.getTime() + 8 * MINUTE),
        kind: "machine",
      },
    ],
    peers: new Map<string, PeerFacts>([
      [key("build-box"), { ...idle, presence: true, lastSync: ago(2 * MINUTE) }],
      [
        key("laptop"),
        {
          ...idle,
          gate: { refusals: 5, nextProbeAt: new Date(now.getTime() + 4 * MINUTE) },
          unreachableSince: ago(9 * DAY),
        },
      ],
      [key("tablet"), { ...idle, presence: true, lastSync: ago(DAY), owed: 1 }],
    ]),
    lines: new Map<string, LineFacts>([
      [
        key("build-box"),
        {
          ...line,
          state: "connected",
          helloCoreId: "core-build-box",
          replaced: { name: "build-box-old", kind: "ssh" },
        },
      ],
      [key("laptop"), { ...line, state: "unreachable", reason: "no route to host" }],
      [key("tablet"), { ...line, state: "connecting" }],
    ]),
    budget: { waiting: 0, halvedUntil: null },
    witnessPool: (subject) =>
      subject === key("laptop") ? { pool: [], ask: key("build-box") } : { pool: [key("build-box")], ask: null },
  };
  return { sources, ids, keys };
}
