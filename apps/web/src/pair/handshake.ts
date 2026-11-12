import { HcConnection } from "@doriface/client";
import { base64urlEncode, closeCodeOf, type PairingSecret, secureLink } from "@doriface/crypto";
import { CloseCode, connectRelayClient } from "@doriface/relay-client";
import type { OpenConnection } from "../connection/connect.ts";
import { BROWSER_DEPS, deviceKeyFor, type RelayDeps } from "../connection/relay-deps.ts";
import type { ConnectionSettings } from "../connection/settings.ts";
import { slotOf } from "./code.ts";
import type { OfferSecret, PairingOffer } from "./fragment.ts";

const AGAIN = "Run doriface-host pair again.";

const REASONS: Readonly<Record<OfferSecret["mode"], Readonly<Record<number, string>>>> = {
  code: {
    [CloseCode.CryptoFailure]: "The code doesn't match this host. Check it and try again.",
    // The relay's slot answer cannot say whether a code came from `mesh pair` (#727), and the host refuses a device
    // pairing on a mesh offer with the same 4401 as a spent code, so the sentence names both.
    [CloseCode.UnknownDevice]:
      "The host refused this code: it was used already or replaced, or it is a mesh invite from doriface-host mesh pair, which adds a machine with doriface-host mesh join and cannot pair this device. Run doriface-host pair for a new device code.",
    [CloseCode.HostOffline]: "The host is not connected to the relay. Start doriface-host and try again.",
    [CloseCode.PairSlotUnknown]: "No host is pairing with this code. It may have expired.",
    [CloseCode.RateLimited]: `Too many attempts for this code. Use the QR code or ${AGAIN.toLowerCase()}`,
  },
  link: {
    [CloseCode.CryptoFailure]: `This pairing link doesn't match this host. ${AGAIN}`,
    [CloseCode.UnknownDevice]: `The host refused this link: it was used already or replaced. ${AGAIN}`,
    [CloseCode.HostOffline]: "The host is not connected to the relay. Start doriface-host and try again.",
    [CloseCode.RateLimited]: "Too many attempts from this network. Wait a few minutes and try again.",
  },
};

const UNREACHABLE = "The relay cannot be reached. Check the network and try again.";

export class PairingFailedError extends Error {
  override readonly name = "PairingFailedError";
}

export function pairingFailureReason(mode: OfferSecret["mode"], closeCode: number | undefined): string | undefined {
  return closeCode === undefined ? undefined : REASONS[mode][closeCode];
}

function pairingOption(secret: OfferSecret, name: string): PairingSecret {
  return secret.mode === "code"
    ? { mode: "code", code: secret.code, name }
    : { mode: "link", linkSecret: secret.linkSecret, name };
}

/** The pairing session once the host answered on it: a full hc session, with what a later drop needs to carry it on. */
export interface PairedSession {
  readonly connection: HcConnection;
  /** The session under the connection and how to dial its host again (contract v1.11): an ordinary relay session. */
  readonly session: NonNullable<OpenConnection["session"]>;
}

/**
 * Runs the pairing session through the relay: a typed code on a `?pair=<slot>` session, a link on an ordinary one.
 * It resolves only after the host answered `hello` on that session, which the host does only once it stored this
 * device, so the next IK session is admitted. The session stays open and is the caller's: a full hc session.
 */
export async function pairWithHost(
  offer: PairingOffer,
  name: string,
  deps: RelayDeps = BROWSER_DEPS,
): Promise<PairedSession> {
  const { secret } = offer;
  const pairing = pairingOption(secret, name);
  const link = await connectRelayClient({
    relayUrl: offer.relayUrl,
    hostId: offer.hostId,
    ...(secret.mode === "code" ? { pairSlot: slotOf(secret.code) } : {}),
  }).catch((error: unknown) => {
    const reason = pairingFailureReason(secret.mode, error instanceof Error ? closeCodeOf(error) : undefined);
    throw new PairingFailedError(reason ?? UNREACHABLE, { cause: error });
  });
  const staticKey = await deviceKeyFor(link, deps);
  try {
    const secure = await secureLink(link, {
      role: "initiator",
      hostId: offer.hostId,
      staticKey,
      remoteStatic: offer.noiseStaticPub,
      pairing,
    });
    const connection = await HcConnection.open(secure);
    // Carried on over an ordinary session: the pairing is done, and a slot is for a pairing handshake only.
    const redial = (signal: AbortSignal): ReturnType<typeof connectRelayClient> =>
      connectRelayClient({ relayUrl: offer.relayUrl, hostId: offer.hostId, signal });
    return { connection, session: { secure, redial } };
  } catch (error) {
    const reason = pairingFailureReason(secret.mode, error instanceof Error ? closeCodeOf(error) : undefined);
    throw reason === undefined ? error : new PairingFailedError(reason, { cause: error });
  }
}

/** The paired host as connection settings remember it. */
export interface RememberedHost {
  readonly hostId: string;
  readonly hostKey: string;
  readonly relayUrl: string;
}

/** Pairs, and saves the host only once the pairing session answered `hello`; a failed pairing saves nothing. */
export async function pairAndRemember(
  offer: PairingOffer,
  name: string,
  save: (host: RememberedHost) => void,
  deps: RelayDeps = BROWSER_DEPS,
): Promise<void> {
  (await pairWithHost(offer, name, deps)).connection.close();
  save(rememberedOf(offer));
}

const rememberedOf = (offer: PairingOffer): RememberedHost => ({
  hostId: offer.hostId,
  hostKey: base64urlEncode(offer.noiseStaticPub),
  relayUrl: offer.relayUrl,
});

/** The app's connections, as pairing binds them to the host just paired (`connectionStore` in connection/store.ts). */
export interface PairedConnections {
  readonly settings: ConnectionSettings;
  pair(settings: ConnectionSettings, opened?: OpenConnection): void;
}

/**
 * Pairs, then binds the app to the host on the session the pairing proved, so the workspace opens on it instead of
 * dialing the relay again (#1271); a failed pairing binds nothing.
 */
export async function pairAndOpen(
  offer: PairingOffer,
  name: string,
  connections: PairedConnections,
  deps: RelayDeps = BROWSER_DEPS,
): Promise<void> {
  const { connection, session } = await pairWithHost(offer, name, deps);
  connections.pair(
    { ...connections.settings, mode: "relay", ...rememberedOf(offer) },
    { connection, path: "relay", session },
  );
}
