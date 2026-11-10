import { HcConnection } from "@doriface/client";
import {
  closeCodeOf,
  fingerprintOf,
  type KeyPair,
  type PairingSecret,
  rawStaticKey,
  type SecureLink,
  secureLink,
  SecureLinkError,
} from "@doriface/crypto";
import {
  connectRelayClient,
  type CreateSocket,
  lookupPairSlot,
  pairSlotOf,
  type WebSocketLink,
} from "@doriface/relay-client";
import { HeldLink } from "./pipe.ts";
import { type KnownHost, KnownHosts } from "../state/known-hosts.ts";
import type { ConnectTarget } from "./target.ts";

export interface DialOptions {
  readonly stateDir: string;
  readonly device: KeyPair;
  /** Overrides the relay a paired host was saved with, and is the relay a typed code is looked up on. */
  readonly relayUrl: string | undefined;
  readonly defaultRelayUrl: string;
  readonly deviceName: string;
  readonly log: (line: string) => void;
  /** For a typed code: the fingerprint (at least its first 4 groups) the person read off the host. */
  readonly fingerprint?: string | undefined;
  /** Lets a pairing replace a saved host whose key or relay differs; without it that pairing is refused. */
  readonly replace?: boolean | undefined;
  /** For tests: the sockets the relay links open. */
  readonly createSocket?: CreateSocket | undefined;
}

export interface Dialed {
  readonly secure: SecureLink;
  readonly link: WebSocketLink;
  readonly held: HeldLink;
}

/**
 * Reaching the host failed: the relay, the handshake, or the host's answer (as against a refusal this machine makes
 * itself before dialing: not paired, no fingerprint, a saved host that needs --replace). The command exits 255 on
 * it, as ssh does when the connection itself fails (exit-code.ts).
 */
export class HostUnreachableError extends Error {
  override readonly name = "HostUnreachableError";

  constructor(cause: Error) {
    super(cause.message, { cause });
  }
}

/** Pairs first when the target is a link or code (again, if this machine paired before), then opens an IK session. */
export async function dial(target: ConnectTarget, options: DialOptions): Promise<Dialed> {
  const host = await resolveHost(target, options);
  const relayUrl = options.relayUrl ?? host.relayUrl;
  try {
    const link = await connectRelayClient({ relayUrl, hostId: host.hostId, ...socketOf(options) });
    try {
      const held = new HeldLink(link);
      const secure = await secureLink(held, initiator(host, options.device));
      return { secure, link, held };
    } catch (error) {
      throw refusal(host.hostId, error);
    }
  } catch (error) {
    throw new HostUnreachableError(error instanceof Error ? error : new Error(String(error)));
  }
}

/** What `doriface-host connect` prints per relay close code; the web app maps the same words back (machine-cause.ts). */
export const REFUSALS: Readonly<Record<number, (hostId: string) => string>> = {
  4400: (hostId) => `the handshake with host ${hostId} failed: its key may not match the one this machine paired with`,
  4401: (hostId) => `host ${hostId} does not know this machine anymore: pair it again`,
  4403: (hostId) => `the relay refused host ${hostId}'s key`,
  4404: (hostId) => `host ${hostId} is not connected to the relay: start doriface-host there`,
  4408: (hostId) => `host ${hostId} did not answer in time`,
  4429: () => "the relay is rate limiting this machine or that host: try again in a minute",
};

/** One clear line for hc to show as the reason, with the close code when there is one. */
function refusal(hostId: string, error: unknown): Error {
  const code = error instanceof Error ? closeCodeOf(error) : undefined;
  const message = code === undefined ? undefined : REFUSALS[code]?.(hostId);
  if (message === undefined) return error instanceof Error ? error : new Error(String(error));
  return new SecureLinkError(code, `${message} (${code})`, { cause: error });
}

const socketOf = (options: DialOptions): { readonly createSocket?: CreateSocket } =>
  options.createSocket === undefined ? {} : { createSocket: options.createSocket };

const initiator = (host: KnownHost, device: KeyPair, pairing?: PairingSecret) =>
  ({
    role: "initiator",
    hostId: host.hostId,
    staticKey: rawStaticKey(device),
    remoteStatic: host.hostKey,
    pairing,
  }) as const;

async function resolveHost(target: ConnectTarget, options: DialOptions): Promise<KnownHost> {
  const known = new KnownHosts(options.stateDir);
  if (target.kind === "host") {
    const host = known.get(target.hostId);
    if (host !== undefined) return host;
    throw new Error(
      `this machine has not paired with host ${target.hostId}: run doriface-host connect <pairing link or code> once`,
    );
  }
  const relayUrl = options.relayUrl ?? options.defaultRelayUrl;
  if (target.kind === "link") {
    const { hostId, noiseStaticPub, linkSecret } = target.link;
    const host = { hostId, hostKey: noiseStaticPub, relayUrl: options.relayUrl ?? target.link.relayUrl };
    return pair(known, host, { mode: "link", linkSecret, name: options.deviceName }, options);
  }
  const record = await lookupPairSlot({ relayUrl, code: target.code });
  if (record === undefined) throw new Error("no host is pairing with this code on the relay: it may have expired");
  confirmFingerprint(options.fingerprint, record.noiseStaticPub);
  const host = { hostId: record.hostId, hostKey: record.noiseStaticPub, relayUrl };
  const pairing = { mode: "code", code: target.code, name: options.deviceName } as const;
  return pair(known, host, pairing, options, pairSlotOf(target.code));
}

const FINGERPRINT_GROUPS = 4;

/** The typed fingerprint, normalized; refused without one, or with fewer than 4 groups, before anything is dialed. */
export function fingerprintGiven(given: string | undefined): string {
  const printed = "the fingerprint doriface-host pair printed on the host";
  if (given === undefined) {
    throw new Error(
      `a typed code needs --fingerprint: give at least the first ${FINGERPRINT_GROUPS} groups of ${printed}`,
    );
  }
  const typed = given.toUpperCase().replaceAll(/[\s-]/g, "");
  if (!/^[0-9A-F]+$/.test(typed) || typed.length < FINGERPRINT_GROUPS * 4) {
    throw new Error(`--fingerprint wants at least the first ${FINGERPRINT_GROUPS} groups of ${printed}`);
  }
  return typed;
}

/**
 * The relay's slot answer is untrusted; as in the web flow, the person confirms the host's fingerprint before the
 * code is used (pairing design D10). The bridge cannot ask, so the fingerprint comes in as an option.
 */
export function confirmFingerprint(given: string | undefined, hostKey: Uint8Array): void {
  const typed = fingerprintGiven(given);
  const actual = fingerprintOf(hostKey);
  if (!actual.replaceAll(" ", "").startsWith(typed)) {
    throw new Error(
      `the host on this code has fingerprint ${actual}, which does not match the one given: do not pair with it`,
    );
  }
}

/**
 * A pairing link or code for a host this machine already saved must not silently change what it trusts: a different
 * key or relay is named on stderr, and only --replace lets the pairing go on. Checked before dialing, so a refusal
 * spends no single-use link and writes nothing here or on the host, and again as the host is saved, in case another
 * pairing saved this hostId meanwhile.
 */
export function confirmReplacement(
  saved: KnownHost | undefined,
  offered: KnownHost,
  options: Pick<DialOptions, "log" | "replace">,
): void {
  if (saved === undefined) return;
  const changes = [
    ...(bytesEqual(saved.hostKey, offered.hostKey)
      ? []
      : [
          `host key changed for ${offered.hostId}: old fingerprint ${fingerprintOf(saved.hostKey)} -> new ${fingerprintOf(offered.hostKey)}`,
        ]),
    ...(saved.relayUrl === offered.relayUrl
      ? []
      : [`relay changed for ${offered.hostId}: ${saved.relayUrl} -> ${offered.relayUrl}`]),
  ];
  for (const change of changes) options.log(change);
  if (changes.length > 0 && options.replace !== true) {
    throw new Error(
      `refusing to replace the saved host ${offered.hostId}: check the change above, then run again with --replace`,
    );
  }
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);

/**
 * Runs the pairing session and saves the host only after it answered `hello`, which it does once it stored this
 * device, so the IK session that follows is admitted.
 */
async function pair(
  known: KnownHosts,
  host: KnownHost,
  pairing: PairingSecret,
  options: DialOptions,
  pairSlot?: string,
): Promise<KnownHost> {
  const checked = known.get(host.hostId);
  confirmReplacement(checked, host, options);
  const link = await connectRelayClient({
    relayUrl: host.relayUrl,
    hostId: host.hostId,
    ...socketOf(options),
    ...(pairSlot === undefined ? {} : { pairSlot }),
    // One socket: the pairing session closes once the host stored this machine (#1418).
    bestOf: 1,
  });
  const secure = await secureLink(link, initiator(host, options.device, pairing)).catch((error: unknown) => {
    throw refusal(host.hostId, error);
  });
  (await HcConnection.open(secure)).close();
  known.replace(host, checked, (saved) => confirmReplacement(saved, host, options));
  options.log(`paired with host ${host.hostId}, fingerprint ${fingerprintOf(host.hostKey)}`);
  options.log(`from now on: doriface-host connect ${host.hostId}`);
  return host;
}
