import {
  closeCodeOf,
  base64urlDecode,
  type KeyPair,
  type PairingSecret,
  type SecureLink,
  secureLink,
  type StaticKey,
} from "@doriface/crypto";
import { JoinRefused, type JoinTarget, type MeshInvite, meshInviteOf } from "@doriface/mesh/join";
import { CloseCode, connectRelayClient } from "@doriface/relay-client";
import { BROWSER_DEPS, deviceKeyFor, type RelayDeps } from "../connection/relay-deps.ts";
import { slotOf } from "../pair/code.ts";
import type { OfferSecret, PairingOffer } from "../pair/fragment.ts";
import { loadSignKey } from "./identity.ts";
import { type BrowserJoined, joinOnLink } from "./joiner.ts";
import { meshNameOf } from "./member-name.ts";
import { MembershipStore } from "./membership.ts";
import type { CardKey } from "../connection/card-key.ts";
import type { BrowserIdentity } from "./identity.ts";
import type { BrowserJoinAnchor } from "../pair/join-anchor.ts";
import type { KeyValueStore } from "../storage/idb.ts";

export interface JoinDeps extends RelayDeps {
  readonly loadSignKey: () => Promise<CardKey | KeyPair>;
  readonly membership: MembershipStore;
  readonly log?: ((line: string) => void) | undefined;
  readonly confirm?: ((code: string) => Promise<boolean>) | undefined;
  readonly storage?: KeyValueStore;
}

export const BROWSER_JOIN_DEPS: JoinDeps = { ...BROWSER_DEPS, loadSignKey, membership: new MembershipStore() };

const AGAIN = "Run doriface-host mesh pair again.";
const OFFLINE = "The host is not connected to the relay. Start doriface-host and try again.";
const USED = `The host refused this invite: it was used already or replaced. ${AGAIN}`;

const REASONS: Readonly<Record<OfferSecret["mode"], Readonly<Record<number, string>>>> = {
  code: {
    [CloseCode.CryptoFailure]: "The code doesn't match this host. Check it and try again.",
    [CloseCode.UnknownDevice]: USED,
    [CloseCode.MeshCodeRefused]: USED,
    [CloseCode.HostOffline]: OFFLINE,
    [CloseCode.PairSlotUnknown]: "No host is inviting with this code. It may have expired.",
    [CloseCode.RateLimited]: `Too many attempts for this code. ${AGAIN}`,
  },
  link: {
    [CloseCode.CryptoFailure]: `This invite doesn't match the host it names. ${AGAIN}`,
    [CloseCode.UnknownDevice]: USED,
    [CloseCode.HostOffline]: OFFLINE,
    [CloseCode.RateLimited]: "Too many attempts from this network. Wait a few minutes and try again.",
  },
};

const UNREACHABLE = "The relay cannot be reached. Check the network and try again.";

function refusalOf(mode: OfferSecret["mode"], error: unknown): JoinRefused | undefined {
  const code = error instanceof Error ? closeCodeOf(error) : undefined;
  const reason = code === undefined ? undefined : REASONS[mode][code];
  return reason === undefined ? undefined : new JoinRefused(reason, { cause: error });
}

/** A typed code that opens a device pairing (`doriface-host pair`), not a mesh invite: it pairs this browser instead. */
export class DeviceCodeOffer extends Error {
  override readonly name = "DeviceCodeOffer";
  readonly offer: PairingOffer;
  constructor(offer: PairingOffer) {
    super("this code pairs a device with its host");
    this.offer = offer;
  }
}

/**
 * Why the inviter's handshake failed. A typed code does not say which offer it opens, and a host refuses a mesh join on
 * a device pairing offer with UnknownDevice before it counts the attempt (`kindRefusal`, `claimCode`), so that refusal
 * hands the same code to the device pairing. A host refuses every other typed-code join (used, expired or replaced)
 * with MeshCodeRefused, which keeps the join's own words (#1492). An older host sends UnknownDevice for those too, and
 * the device pairing then refuses the code in its own words.
 */
export function dialRefusalOf(offer: PairingOffer, error: unknown): Error | undefined {
  if (offer.secret.mode === "code" && error instanceof Error && closeCodeOf(error) === CloseCode.UnknownDevice) {
    return new DeviceCodeOffer({ ...offer, target: "device" });
  }
  return refusalOf(offer.secret.mode, error);
}

/** A link says what it admits; a code's offer kind is the inviter's to judge (the shared guard's rule). */
const joinTargetOf = (offer: PairingOffer): JoinTarget =>
  offer.secret.mode === "code" ? { kind: "code" } : { kind: "link", mesh: offer.target === "mesh" };

/**
 * Every refusal that needs no network, before anything is dialed: the device/mesh split (`meshInviteOf`, the same
 * words the host CLI uses), then a membership this browser already holds.
 */
export async function refuseEarly(offer: PairingOffer, membership: MembershipStore): Promise<MeshInvite> {
  const invite = meshInviteOf(joinTargetOf(offer));
  const held = await membership.read();
  if (held !== undefined) throw new JoinRefused(`this browser is in mesh ${held.meshId} already`);
  return invite;
}

interface Dialed {
  readonly secure: SecureLink;
  readonly sign: CardKey | KeyPair;
  readonly device: StaticKey;
}

async function dialInviter(offer: PairingOffer, name: string, deps: JoinDeps): Promise<Dialed> {
  const { secret } = offer;
  const pairing: PairingSecret =
    secret.mode === "code"
      ? { mode: "code", code: secret.code, name }
      : { mode: "link", linkSecret: secret.linkSecret, name };
  const link = await connectRelayClient({
    relayUrl: offer.relayUrl,
    hostId: offer.hostId,
    ...(secret.mode === "code" ? { pairSlot: slotOf(secret.code) } : {}),
    // One socket: the join's session closes once the welcome is stored (#1418).
    bestOf: 1,
  }).catch((error: unknown) => {
    throw refusalOf(secret.mode, error) ?? new JoinRefused(UNREACHABLE, { cause: error });
  });
  const device = await deviceKeyFor(link, deps);
  const sign = await deps.loadSignKey().catch((error: unknown) => {
    link.close();
    throw error;
  });
  try {
    const secure = await secureLink(link, {
      role: "initiator",
      hostId: offer.hostId,
      staticKey: device,
      remoteStatic: offer.noiseStaticPub,
      pairing,
      stream: "mesh",
    });
    return { secure, sign, device };
  } catch (error) {
    throw dialRefusalOf(offer, error) ?? error;
  }
}

/**
 * Joins the mesh a mesh invite names, as this browser: the pairing handshake over the relay with the browser's own
 * device key and `stream: "mesh"`, then the shared joiner. The join's session is closed afterwards: a client never
 * syncs over the mesh stream, and the inviter closes it 4401 once the join is over (`host-sync.ts`, `#attach`).
 */
export async function joinMesh(
  offer: PairingOffer,
  deviceName: string,
  deps: JoinDeps = BROWSER_JOIN_DEPS,
): Promise<BrowserJoined> {
  const invite = await refuseEarly(offer, deps.membership);
  const name = meshNameOf(deviceName);
  const { secure, sign, device } = await dialInviter(offer, name, deps);
  try {
    const inviter = { hostId: offer.hostId, hostKey: offer.noiseStaticPub, relayUrl: offer.relayUrl };
    return await joinOnLink(secure, inviter, {
      invite,
      sign,
      device,
      name,
      membership: deps.membership,
      log: deps.log,
      confirm: deps.confirm,
      handshakeHash: secure.handshakeHash,
      ...(deps.storage === undefined ? {} : { storage: deps.storage }),
    });
  } finally {
    secure.close();
  }
}

/** UI uses the same relay dial as the programmatic joiner, with the shared invite guard before it. */
export async function openBrowserJoin(
  offer: PairingOffer,
  identity: BrowserIdentity,
  name: string,
): Promise<SecureLink> {
  meshInviteOf(joinTargetOf(offer));
  return (
    await dialInviter(offer, name, {
      loadDeviceKey: async () => identity.device,
      loadSignKey: async () => identity.card,
      membership: BROWSER_JOIN_DEPS.membership,
    })
  ).secure;
}

export function openBrowserResume(anchor: BrowserJoinAnchor, identity: BrowserIdentity): Promise<SecureLink> {
  return openRosterSession(
    { hostId: anchor.dialed.hostId, hostKey: anchor.dialed.noisePub, relayUrl: anchor.relayUrl },
    identity,
  );
}

export async function openRosterSession(
  member: { readonly hostId: string; readonly hostKey: string; readonly relayUrl: string },
  identity: BrowserIdentity,
): Promise<SecureLink> {
  const link = await connectRelayClient({ relayUrl: member.relayUrl, hostId: member.hostId });
  try {
    return await secureLink(link, {
      role: "initiator",
      hostId: member.hostId,
      staticKey: identity.device,
      remoteStatic: base64urlDecode(member.hostKey),
      stream: "roster",
    });
  } catch (error) {
    link.close();
    throw error;
  }
}
