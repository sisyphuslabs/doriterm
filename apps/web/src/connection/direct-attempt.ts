import type { ByteLink } from "@doriface/client";
import { CloseCode, type SecureLink, SecureLinkError } from "@doriface/crypto";
import { LinkAbortedError, LinkCloseError, openWebSocketLink } from "./ws-link.ts";

/** How long the direct address has to answer with a proved handshake before the relay is dialed (#446 §2). */
export const DIRECT_BUDGET_MS = 300;
/** The host's session route carries ciphertext only; the token subprotocol is never sent here (#446 §1). */
export const DIRECT_SUBPROTOCOL = "doriface.v1";
/** How often a direct link pings the host, which closes a socket that sent nothing for `DIRECT_IDLE_MS` (90 s). */
export const DIRECT_PING_MS = 30_000;

/** Opens a socket to a host's session route (or to the desktop shell's forward of one). */
export function openDirectLink(
  url: string,
  signal: AbortSignal | undefined,
  pingIntervalMs = DIRECT_PING_MS,
): Promise<ByteLink> {
  return openWebSocketLink(url, [DIRECT_SUBPROTOCOL], { pingIntervalMs, ...(signal === undefined ? {} : { signal }) });
}

/**
 * Why a direct attempt did not carry the session. Local categories only: never peer text, never a guessed cause. The UI
 * shows one of these, and none of them names an address or a key (#446 §1).
 */
export type DirectReason = "blocked" | "unusable-address" | "no-answer" | "could-not-connect" | "authentication-failed";

export class DirectFailure extends Error {
  override readonly name = "DirectFailure";
  readonly reason: DirectReason;

  constructor(reason: DirectReason, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.reason = reason;
  }
}

export interface DirectAttemptOptions<S extends SecureLink = SecureLink> {
  /** The normalised `ws(s)://host:port/v1/e2ee` this attempt dials. */
  readonly url: string;
  /** The same pinned session the relay path runs: Noise IK over this socket, stream `hc` (#446 §1). */
  readonly secure: (link: ByteLink) => Promise<S>;
  readonly budgetMs?: number | undefined;
  /** The caller's own cancellation (a settings change, `stop()`); it behaves like the budget running out. */
  readonly signal?: AbortSignal | undefined;
  /** For tests: opens a socket that is not a browser WebSocket. */
  readonly open?: ((url: string, signal: AbortSignal) => Promise<ByteLink>) | undefined;
}

function remaining(controller: AbortController): void {
  const reason: unknown = controller.signal.reason;
  if (!(reason instanceof DirectFailure))
    controller.abort(new DirectFailure("no-answer", "the direct attempt was cancelled"));
}

const abortFailure = (controller: AbortController): DirectFailure => {
  const reason: unknown = controller.signal.reason;
  return reason instanceof DirectFailure ? reason : new DirectFailure("no-answer", "the direct attempt was cancelled");
};

function reasonOf(error: unknown, expired: boolean): DirectReason {
  if (error instanceof DirectFailure) return error.reason;
  if (expired) return "no-answer";
  if (error instanceof LinkAbortedError) return "no-answer";
  if (error instanceof LinkCloseError) return "could-not-connect";
  if (error instanceof SecureLinkError) {
    if (error.code === CloseCode.UnknownDevice || error.code === CloseCode.CryptoFailure)
      return "authentication-failed";
    if (error.code === CloseCode.IdleTimeout) return "no-answer";
    return "could-not-connect";
  }
  if (error instanceof Error && error.name === "SecurityError") return "blocked";
  return "could-not-connect";
}

/**
 * Races one direct attempt: the socket and the Noise handshake both start at once, and the attempt owns one deadline.
 * The handshake proves the pinned host key, so an answer is a session, not an open socket. At the deadline the socket is
 * closed and the attempt fails with `no-answer`; a result that arrives later is never selected (#446 §2).
 */
export async function attemptDirect<S extends SecureLink>(options: DirectAttemptOptions<S>): Promise<S> {
  const budget = options.budgetMs ?? DIRECT_BUDGET_MS;
  const controller = new AbortController();
  let expired = false;
  // An unbounded budget arms no timer: setTimeout would read Infinity as no delay at all.
  const timer = Number.isFinite(budget)
    ? setTimeout(() => {
        expired = true;
        controller.abort(new DirectFailure("no-answer", `no answer within ${budget} ms`));
      }, budget)
    : undefined;
  const caller = options.signal;
  const onCallerAbort = (): void => remaining(controller);
  if (caller?.aborted === true) onCallerAbort();
  else caller?.addEventListener("abort", onCallerAbort, { once: true });

  let link: ByteLink | undefined;
  const open = options.open ?? ((url: string, signal: AbortSignal) => openDirectLink(url, signal));
  try {
    link = await open(options.url, controller.signal);
    const socket = link;
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = (): void => {
        socket.close();
        reject(abortFailure(controller));
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const secured = options.secure(socket);
    // The losing side of the race is abandoned on purpose: a handshake that answers after the deadline is never adopted.
    void secured.catch(() => undefined);
    try {
      const result = await Promise.race([secured, aborted]);
      if (controller.signal.aborted) {
        result.close();
        throw abortFailure(controller);
      }
      return result;
    } catch (error) {
      socket.close();
      throw controller.signal.aborted ? abortFailure(controller) : error;
    }
  } catch (error) {
    throw error instanceof DirectFailure
      ? error
      : new DirectFailure(reasonOf(error, expired), error instanceof Error ? error.message : String(error), {
          cause: error,
        });
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onCallerAbort);
    if (controller.signal.aborted) link?.close();
  }
}
