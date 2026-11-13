import {
  HcConnectionClosedError,
  HcHandshakeTimeoutError,
  HcLinkSilentError,
  HcTimeoutError,
  LinkClosedError,
} from "@doriface/client";
import { SecureLinkError } from "@doriface/crypto";
import { HcRpcError } from "@doriface/protocol";
import { RelayCloseError } from "@doriface/relay-client";
import { LinkCloseError } from "../connection/ws-link.ts";
import { WakeProbeUnansweredError } from "../connection/wake.ts";
import { recordRecovery } from "./recovery-metrics.ts";

/** A stream ended without the program ending; reattaching is safe, rerunning the program is not. */
export class TerminalStreamLostError extends Error {}

const TRANSIENT_CLOSE_CODES: ReadonlySet<number> = new Set([
  1001, 1005, 1006, 1011, 1012, 1013, 4404, 4408, 4409, 4412,
]);

/** Unknown failures stay visible. Only evidence of an interrupted connection earns an automatic retry. */
export function transientAttachFailure(cause: unknown): boolean {
  if (
    cause instanceof HcConnectionClosedError ||
    cause instanceof LinkClosedError ||
    cause instanceof WakeProbeUnansweredError ||
    cause instanceof HcHandshakeTimeoutError ||
    cause instanceof HcLinkSilentError ||
    cause instanceof HcTimeoutError ||
    cause instanceof TerminalStreamLostError
  )
    return true;
  if (cause instanceof LinkCloseError || cause instanceof RelayCloseError) return TRANSIENT_CLOSE_CODES.has(cause.code);
  // A secured link (relay or direct) reports its transport's close as a SecureLinkError carrying the same code (#2224).
  if (cause instanceof SecureLinkError) return cause.code !== undefined && TRANSIENT_CLOSE_CODES.has(cause.code);
  if (!(cause instanceof HcRpcError)) return false;
  return (
    ["unavailable", "unreachable", "timeout", "connection_closed"].includes(cause.kind) ||
    // Older cores report an unavailable mesh member as internal; keep this match specific to that wire response.
    (cause.kind === "internal" && /^machine .+ is (unreachable|unavailable)\b/.test(cause.message))
  );
}

/**
 * What recovery is told when a stream ended because its connection went away. The next connection re-attaches it, so the
 * loss is transient (#2224), unless the link closed with a code that is not (an auth or crypto refusal: 4400, 4401,
 * 4403): that error is passed on as it is, so the pane offers Try again at once rather than retrying.
 */
export function droppedStreamCause(error: Error | undefined): Error {
  const link = error instanceof SecureLinkError || error instanceof RelayCloseError || error instanceof LinkCloseError;
  if (link && error.code !== undefined && !TRANSIENT_CLOSE_CODES.has(error.code)) return error;
  return new HcConnectionClosedError("The connection dropped.", { cause: error });
}

export type RecoveryState =
  | { readonly phase: "idle" }
  | { readonly phase: "reconnecting" | "failed"; readonly cause: unknown; readonly transient: boolean };

const DELAYS = [250, 500, 1_000] as const;
const STABLE_MS = 10_000;
const INTERACTION_QUIET_MS = 1_000;
const INTERACTION_COOLDOWN_MS = 250;

/** One pane's retry budget. The callback opens a viewer only; this object never receives a command or input. */
export class AttachRecovery {
  #state: RecoveryState = { phase: "idle" };
  #timer: ReturnType<typeof setTimeout> | undefined;
  #busy = false;
  #retries = 0;
  #openedAt: number | undefined;
  #viewCounted = false;
  #source: "automatic" | "interaction" | "manual" = "automatic";
  #manualAt: number | undefined;
  #manualFirst = false;
  #lastInteraction: number | undefined;
  #lastAcceleratedAt: number | undefined;
  #interactionCycleUsed = false;
  readonly #retry: () => void;
  readonly #changed: (state: RecoveryState) => void;

  constructor(retry: () => void, changed: (state: RecoveryState) => void) {
    this.#retry = retry;
    this.#changed = changed;
  }

  get state(): RecoveryState {
    return this.#state;
  }

  begin(): boolean {
    if (this.#busy) return false;
    this.#cancelTimer();
    this.#busy = true;
    if (!this.#viewCounted) {
      this.#viewCounted = true;
      recordRecovery("views");
    }
    recordRecovery("attachAttempts");
    return true;
  }

  succeeded(): void {
    this.#busy = false;
    if (this.#state.phase !== "idle") {
      if (this.#source === "manual") {
        if (this.#manualFirst && this.#manualAt !== undefined && Date.now() - this.#manualAt <= 2_000)
          recordRecovery("manualImmediateSuccesses");
      } else recordRecovery(this.#source === "automatic" ? "automaticRecoveries" : "interactionRecoveries");
    }
    this.#openedAt = Date.now();
    this.#source = "automatic";
    this.#manualFirst = false;
    this.#set({ phase: "idle" });
  }

  failed(cause: unknown): void {
    this.#busy = false;
    this.#manualFirst = false;
    if (this.#openedAt !== undefined && Date.now() - this.#openedAt >= STABLE_MS) this.#resetBudget();
    this.#openedAt = undefined;
    const transient = transientAttachFailure(cause);
    const delay = DELAYS[this.#retries];
    if (!transient || delay === undefined) {
      this.#set({ phase: "failed", cause, transient });
      return;
    }
    this.#set({ phase: "reconnecting", cause, transient });
    this.#timer = setTimeout(() => this.#next(), delay * (0.8 + Math.random() * 0.4));
  }

  /**
   * Input advances a pending attempt at most once per 250 ms. After exhaustion, one fresh bounded cycle is permitted
   * after 1 s of quiet; further input cannot renew this outage's budget. Manual retry remains available.
   */
  interact(): boolean {
    const now = Date.now();
    const newBurst = this.#lastInteraction === undefined || now - this.#lastInteraction >= INTERACTION_QUIET_MS;
    this.#lastInteraction = now;
    if (this.#busy || this.#state.phase === "idle" || !this.#state.transient) return false;
    if (this.#lastAcceleratedAt !== undefined && now - this.#lastAcceleratedAt < INTERACTION_COOLDOWN_MS) return false;
    if (this.#state.phase === "failed") {
      if (!newBurst || this.#interactionCycleUsed) return false;
      this.#interactionCycleUsed = true;
      this.#retries = 0;
    }
    this.#lastAcceleratedAt = now;
    this.#source = "interaction";
    this.#next();
    return true;
  }

  /**
   * The pane came into view. An attempt that came due while it was hidden found no view to attach and is still owed: it
   * runs now, outside the input rate limit, and its retry was already counted. Otherwise showing is an interaction,
   * including while a retry timer is still pending.
   */
  shown(): void {
    if (this.#busy || this.#state.phase !== "reconnecting" || this.#timer !== undefined) {
      this.interact();
      return;
    }
    this.#source = "interaction";
    this.#next(false);
  }

  /** An explicit retry may retry even a terminal error, after the person has corrected it. */
  manual(): void {
    if (this.#busy) return;
    recordRecovery("manualRetries");
    this.#manualAt = Date.now();
    this.#manualFirst = true;
    this.#source = "manual";
    this.#resetBudget();
    this.#next(false);
  }

  /** Invalidate the old connection/address's work before accepting its replacement. */
  reset(): void {
    this.#cancelTimer();
    this.#busy = false;
    this.#resetBudget();
    this.#openedAt = undefined;
    this.#source = "automatic";
    this.#manualFirst = false;
    this.#lastInteraction = undefined;
    this.#set({ phase: "idle" });
  }

  stop(): void {
    this.#cancelTimer();
    this.#busy = false;
  }

  #resetBudget(): void {
    this.#retries = 0;
    this.#lastAcceleratedAt = undefined;
    this.#interactionCycleUsed = false;
  }

  #next(automatic = true): void {
    this.#cancelTimer();
    if (this.#busy || this.#state.phase === "idle") return;
    if (automatic) this.#retries += 1;
    this.#set({ ...this.#state, phase: "reconnecting" });
    this.#retry();
  }

  #cancelTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #set(state: RecoveryState): void {
    this.#state = state;
    this.#changed(state);
  }
}
