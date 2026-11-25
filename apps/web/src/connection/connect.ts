import { HcConnection, HcHandshakeTimeoutError, HELLO_REQUEST_LINE } from "@doriface/client";
import type { ByteLink } from "@doriface/client";
import { base64urlDecode, CloseCode, type SecureSession, secureLink, SecureLinkError } from "@doriface/crypto";
import { connectRelayClient } from "@doriface/relay-client";
import { directDial, type PageAccess, pageAccess, parseDirectAddress } from "./direct-address.ts";
import { attemptDirect, DIRECT_BUDGET_MS, DirectFailure, type DirectReason, openDirectLink } from "./direct-attempt.ts";
import { directBudgetProbe } from "./direct-budget-probe.ts";
import { canForwardPlainWs, openForwardedLink } from "./direct-forward.ts";
import { DIRECT_PATH_ENABLED } from "./direct-switch.ts";
import { BROWSER_DEPS, deviceKeyFor, type RelayDeps } from "./relay-deps.ts";
import type { ResumableSession } from "./session-resume.ts";
import type { ConnectionSettings } from "./settings.ts";
import { loopbackOnly } from "./loopback-address.ts";
import { openWebSocketLink } from "./ws-link.ts";

const SUBPROTOCOL = "doriface.v1";
const TOKEN_PREFIX = "doriface.token.";

/** The host no longer knows this device (revoked, or its state was reset): retrying cannot help, pairing again can. */
export class DeviceNotPairedError extends Error {
  override readonly name = "DeviceNotPairedError";
  constructor() {
    super("The host does not know this device anymore. Pair it again.");
  }
}

/** Which transport carried the session, so the workspace can say Direct or Relay (#446 §5). */
export type ConnectionPath = "direct" | "relay" | "loopback";

/** A session that opened, and the path it opened on; `directReason` says why direct did not carry it, when one is set. */
export interface OpenConnection {
  readonly connection: HcConnection;
  readonly path: ConnectionPath;
  readonly directReason?: DirectReason | undefined;
  /**
   * The encrypted session under the connection and how to dial its path again, so a dropped socket is carried on
   * instead of the session being opened anew (contract v1.11). Absent on the loopback path, which has no session.
   */
  readonly session?: ResumableSession | undefined;
}

export interface OpenOptions {
  /** What this page may open itself; the browser's own secure context and the desktop shell's forwarder (#446 §0). */
  readonly page?: PageAccess | undefined;
  /** The direct race's budget; the contract's 300 ms unless a test needs another. */
  readonly budgetMs?: number | undefined;
  /** This attempt dials the relay at once: the one before it was a direct link that dropped (#446 §4). */
  readonly skipDirect?: boolean | undefined;
  /** Runs the direct race though the switch is off (`DIRECT_PATH_ENABLED`): for tests of the mechanism only. */
  readonly directPath?: boolean | undefined;
  /**
   * How long the whole attempt may take before it fails and everything it opened is closed (#653). The store grows this
   * after an attempt times out, so a slower path still gets a chance while a dead one cannot hold the UI.
   */
  readonly deadlineMs?: number | undefined;
}

/** This page's access: a secure context refuses plain `ws://` to another machine unless the shell forwards it (#449). */
const thisPage = (): PageAccess => ({ ...pageAccess(), forwardsPlainWs: canForwardPlainWs() });

/**
 * Opens a framed herdr-core connection with the given settings. In relay mode the relay carries the session (#2070).
 * With the direct path switched on, the desktop shell tries a saved direct address first with the same pinned Noise
 * session; the relay carries the session when direct does not answer within the budget, or fails for any reason, so a
 * broken direct address never costs the connection (#446 §2). A browser has no direct path either way: its sessions are
 * the relay's (#1381 §8).
 */
export async function connect(
  settings: ConnectionSettings,
  signal?: AbortSignal,
  deps: RelayDeps = BROWSER_DEPS,
  options: OpenOptions = {},
): Promise<OpenConnection> {
  const deadlineMs = options.deadlineMs;
  if (deadlineMs === undefined) return openOnPath(settings, signal, deps, options);
  return withinDeadline(settings, signal, deps, options, deadlineMs);
}

/**
 * The attempt bounded by `deadlineMs`: when it runs out, or the caller cancels, the attempt fails at once and anything
 * that arrives afterwards is closed instead of adopted (#653). Every step the attempt runs takes the controller's
 * signal, so a dial or handshake still in flight is closed rather than left to its own timeout.
 */
async function withinDeadline(
  settings: ConnectionSettings,
  signal: AbortSignal | undefined,
  deps: RelayDeps,
  options: OpenOptions,
  deadlineMs: number,
): Promise<OpenConnection> {
  const deadline = new AbortController();
  const fail = (reason: unknown): void => deadline.abort(reason instanceof Error ? reason : new Error(String(reason)));
  const timer = setTimeout(() => fail(new Error(`no session within ${deadlineMs} ms`)), deadlineMs);
  const onCaller = (): void => fail(signal?.reason);
  if (signal?.aborted === true) onCaller();
  else signal?.addEventListener("abort", onCaller, { once: true });
  const attempt = openOnPath(settings, deadline.signal, deps, options);
  try {
    return await Promise.race([
      attempt,
      new Promise<never>((_, reject) => {
        const onExpire = (): void => reject(deadline.signal.reason);
        if (deadline.signal.aborted) onExpire();
        else deadline.signal.addEventListener("abort", onExpire, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCaller);
    void attempt.then(
      (opened) => {
        if (deadline.signal.aborted) opened.connection.close();
        return undefined;
      },
      () => undefined,
    );
  }
}

async function openOnPath(
  settings: ConnectionSettings,
  signal: AbortSignal | undefined,
  deps: RelayDeps,
  options: OpenOptions,
): Promise<OpenConnection> {
  if (settings.mode === "loopback") {
    const link = await openWebSocketLink(
      loopbackOnly(settings.loopbackUrl, "hc"),
      [SUBPROTOCOL, TOKEN_PREFIX + settings.token],
      signal === undefined ? {} : { signal },
    );
    return { connection: await HcConnection.open(link, signal === undefined ? {} : { signal }), path: "loopback" };
  }
  const direct = await openDirect(settings, signal, deps, options);
  if ("connection" in direct) return { connection: direct.connection, path: "direct", session: direct.session };
  signal?.throwIfAborted();
  const relayed = await openRelaySession(settings, deps, signal);
  const connection = await HcConnection.open(relayed, { helloSent: true, ...(signal === undefined ? {} : { signal }) });
  return {
    connection,
    path: "relay",
    session: { secure: relayed, redial: (again) => dialRelay(settings, again) },
    ...(direct.reason === undefined ? {} : { directReason: direct.reason }),
  };
}

type DirectOutcome =
  | { readonly connection: HcConnection; readonly session: ResumableSession }
  | { readonly reason: DirectReason | undefined };

/**
 * One direct attempt at a saved address. Every failure is a value here: the caller dials the relay next, so an address
 * that cannot be used costs a reason, never the connection.
 */
async function openDirect(
  settings: ConnectionSettings,
  signal: AbortSignal | undefined,
  deps: RelayDeps,
  options: OpenOptions,
): Promise<DirectOutcome> {
  // #2070: the direct path is off. connect() goes to the relay, and the address a file holds is left unused; no reason
  // is set, as no attempt was made.
  if (!(options.directPath ?? DIRECT_PATH_ENABLED)) return { reason: undefined };
  // #1381 §8: a browser reaches every member over the relay. Only the desktop shell's forwarder may dial a saved
  // address, so everywhere else connect() goes to the relay and the address an older file holds is left unused.
  if (!canForwardPlainWs()) return { reason: undefined };
  if (options.skipDirect === true) return { reason: undefined };
  const address = parseDirectAddress(settings.directUrl);
  if (!address.usable) return { reason: address.reason === "no address is set" ? undefined : "unusable-address" };
  const dial = directDial(address, options.page ?? thisPage());
  if (dial.kind === "blocked") return { reason: "blocked" };
  const open =
    dial.kind === "forward" ? (url: string, attempt: AbortSignal) => openForwardedLink(url, attempt) : undefined;
  const budgetMs = options.budgetMs ?? directBudgetProbe() ?? DIRECT_BUDGET_MS;
  const startedAt = performance.now();
  try {
    const secured = await attemptDirect({
      url: dial.url,
      ...(open === undefined ? {} : { open }),
      budgetMs,
      ...(signal === undefined ? {} : { signal }),
      secure: (link) => openSessionOn(link, settings, deps),
    });
    const connection = await provedSession(secured, budgetMs - (performance.now() - startedAt), signal);
    const redial = (again: AbortSignal): Promise<ByteLink> =>
      open === undefined ? openDirectLink(dial.url, again) : open(dial.url, again);
    return { connection, session: { secure: secured, redial } };
  } catch (error) {
    return { reason: directFailureReason(error) };
  }
}

/**
 * Why the framed hello did not make a session, in the words the status bar uses. The error decides, never a clock: the
 * deadline's own timeout has a class of its own, while a handshake that finished early with an unusable answer (a core
 * mismatch, a malformed reply, a socket that closed) is the host's answer being wrong, not its absence (#744).
 */
export function helloFailureReason(error: unknown): DirectReason {
  return error instanceof HcHandshakeTimeoutError ? "no-answer" : "could-not-connect";
}

/**
 * The framed hello is the rest of the proof: it runs on what is left of the direct budget, so a host that answers the
 * Noise handshake and then stalls cannot hold the session instead of the relay (#640).
 */
async function provedSession(
  link: SecureSession,
  leftMs: number,
  signal: AbortSignal | undefined,
): Promise<HcConnection> {
  const left = Math.max(0, leftMs);
  try {
    return await HcConnection.open(link, {
      helloSent: true,
      handshakeTimeoutMs: left,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    const reason = helloFailureReason(error);
    throw new DirectFailure(
      reason,
      reason === "no-answer" ? "no answer within the budget" : "the direct session was not proved",
      { cause: error },
    );
  }
}

function directFailureReason(error: unknown): DirectReason {
  return error instanceof DirectFailure ? error.reason : "could-not-connect";
}

/** One relay socket to the host: the session's first, and each one a resume carries it on over. */
const dialRelay = (settings: ConnectionSettings, signal: AbortSignal | undefined): Promise<ByteLink> =>
  connectRelayClient({
    relayUrl: settings.relayUrl,
    hostId: settings.hostId,
    ...(signal === undefined ? {} : { signal }),
  });

async function openRelaySession(
  settings: ConnectionSettings,
  deps: RelayDeps,
  signal: AbortSignal | undefined,
): Promise<SecureSession> {
  return openSessionOn(await dialRelay(settings, signal), settings, deps);
}

const HELLO_LINE = new TextEncoder().encode(HELLO_REQUEST_LINE);

/**
 * The session both paths run after their socket is open: Noise IK as the initiator, pinned to the paired host key. hc's
 * hello rides in message 1, so its answer can come back with message 2 instead of a round trip later (#1271).
 */
async function openSessionOn(link: ByteLink, settings: ConnectionSettings, deps: RelayDeps): Promise<SecureSession> {
  const staticKey = await deviceKeyFor(link, deps);
  try {
    return await secureLink(link, {
      role: "initiator",
      hostId: settings.hostId,
      staticKey,
      remoteStatic: base64urlDecode(settings.hostKey),
      early: HELLO_LINE,
    });
  } catch (error) {
    if (error instanceof SecureLinkError && error.code === CloseCode.UnknownDevice) throw new DeviceNotPairedError();
    throw error;
  }
}
