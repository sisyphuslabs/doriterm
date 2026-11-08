import {
  closeCodeOf,
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

export interface JoinDeps extends RelayDeps {
  readonly loadSignKey: () => Promise<KeyPair>;
  readonly membership: MembershipStore;
  readonly log?: ((line: string) => void) | undefined;
}

export const BROWSER_JOIN_DEPS: JoinDeps = { ...BROWSER_DEPS, loadSignKey, membership: new MembershipStore() };

const AGAIN = "Run doriface-host mesh pair again.";
const OFFLINE = "The host is not connected to the relay. Start doriface-host and try again.";
const USED = `The host refused this invite: it was used already or replaced. ${AGAIN}`;

const REASONS: Readonly<Record<OfferSecret["mode"], Readonly<Record<number, string>>>> = {
  code: {
    [CloseCode.CryptoFailure]: "The code doesn't match this host. Check it and try again.",
    [CloseCode.UnknownDevice]: USED,
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
  readonly sign: KeyPair;
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
    throw refusalOf(secret.mode, error) ?? error;
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
    });
  } finally {
    secure.close();
  }
}
