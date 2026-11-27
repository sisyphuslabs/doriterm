import { JoinRefused, parseLine, type JoinAnchor } from "@doriface/mesh/join";
import { deviceStore, type KeyValueStore } from "../storage/idb.ts";

export interface BrowserJoinAnchor extends JoinAnchor {
  readonly name: string;
  readonly relayUrl: string;
  readonly inviterName: string;
  /** The key slot the join runs on (#2861), so a resume offers the same keys; an anchor without one is the default. */
  readonly keySlot?: string;
  /** The generation the join was claimed at: a resume continues that enrollment only, never a later one. */
  readonly generation?: number;
}

export const JOIN_ANCHOR_KEY = "mesh.join-anchor";

export async function loadJoinAnchor(storage: KeyValueStore = deviceStore): Promise<BrowserJoinAnchor | undefined> {
  const saved = await storage.get(JOIN_ANCHOR_KEY);
  if (saved == null) return undefined;
  const unreadable = async (): Promise<never> => {
    await storage.put(JOIN_ANCHOR_KEY, null);
    throw new JoinRefused("The saved join cannot be read. Ask for a new invite");
  };
  if (typeof saved !== "object") return unreadable();
  const field = (key: string): unknown => Reflect.get(saved, key);
  const offer = parseLine(JSON.stringify(field("offer")));
  const dialed = field("dialed");
  const h = field("h");
  const Nj = field("Nj");
  const expiresAt = field("expiresAt");
  const confirmed = field("confirmed");
  const name = field("name");
  const relayUrl = field("relayUrl");
  const inviterName = field("inviterName");
  const keySlot = field("keySlot");
  const generation = field("generation");
  if (
    offer === undefined ||
    offer === "unknown" ||
    offer.t !== "offer" ||
    offer.commit === undefined ||
    typeof dialed !== "object" ||
    dialed === null ||
    typeof h !== "string" ||
    typeof Nj !== "string" ||
    typeof expiresAt !== "number" ||
    typeof confirmed !== "boolean" ||
    typeof name !== "string" ||
    typeof relayUrl !== "string" ||
    typeof inviterName !== "string" ||
    (keySlot !== undefined && typeof keySlot !== "string") ||
    (generation !== undefined && typeof generation !== "number")
  )
    return unreadable();
  const hostId: unknown = Reflect.get(dialed, "hostId");
  const noisePub: unknown = Reflect.get(dialed, "noisePub");
  if (typeof hostId !== "string" || typeof noisePub !== "string") return unreadable();
  if (Date.now() >= expiresAt) {
    await storage.put(JOIN_ANCHOR_KEY, null);
    throw new JoinRefused("Ask for a new invite");
  }
  return {
    offer: { ...offer, commit: offer.commit },
    dialed: { hostId, noisePub },
    h,
    Nj,
    expiresAt,
    confirmed,
    name,
    relayUrl,
    inviterName,
    ...(typeof keySlot === "string" ? { keySlot } : {}),
    ...(typeof generation === "number" ? { generation } : {}),
  };
}
