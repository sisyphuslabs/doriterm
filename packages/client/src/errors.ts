import { GENERATION } from "./generation.ts";

export class HcConnectionClosedError extends Error {
  override readonly name = "HcConnectionClosedError";
}

export class HcHandshakeError extends Error {
  // string, not the literal: HcCoreMismatchError names itself.
  override readonly name: string = "HcHandshakeError";
}

/**
 * The framed hello got no reply inside its deadline, so the core may be silent rather than wrong. Its own class, because a
 * caller has to tell "no answer" from the three handshake errors that mean the core answered and its answer is unusable
 * (#744): only this one may be reported as a host that did not answer.
 */
export class HcHandshakeTimeoutError extends HcHandshakeError {
  override readonly name = "HcHandshakeTimeoutError";
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`no hello reply within ${timeoutMs} ms`);
    this.timeoutMs = timeoutMs;
  }
}

/** A core this client cannot use, and what says so: the protocol generation it speaks, or its version under the floor. */
export type HcCoreMismatch =
  /** The core speaks a newer protocol generation than this client: the client needs an update. */
  | { readonly kind: "core-newer"; readonly generation: number }
  /** The core speaks an older protocol generation: the core needs an update to at least `need`. */
  | { readonly kind: "core-older"; readonly generation: number; readonly need: string }
  /** The core's version is under the floor: it needs an update to at least `need`. */
  | { readonly kind: "core-too-old"; readonly version: string; readonly need: string }
  /** The core's build lacks methods this client calls: the core needs an update to at least `need`. */
  | { readonly kind: "core-missing"; readonly methods: readonly string[]; readonly need: string };

function mismatchMessage(mismatch: HcCoreMismatch): string {
  switch (mismatch.kind) {
    case "core-too-old":
      return `core is hc ${mismatch.version}, this client needs ${mismatch.need} or newer`;
    case "core-missing":
      return `core lacks ${mismatch.methods.join(", ")}, which this client calls`;
    case "core-newer":
    case "core-older":
      return `core speaks protocol generation ${mismatch.generation}, this client ${GENERATION}`;
  }
}

/** A handshake that reached a core this client cannot use; retrying cannot help, an update on one side can (#651). */
export class HcCoreMismatchError extends HcHandshakeError {
  override readonly name = "HcCoreMismatchError";
  readonly mismatch: HcCoreMismatch;

  constructor(mismatch: HcCoreMismatch) {
    super(mismatchMessage(mismatch));
    this.mismatch = mismatch;
  }
}

export class HcProtocolError extends Error {
  override readonly name = "HcProtocolError";
}

export class HcTimeoutError extends Error {
  override readonly name = "HcTimeoutError";
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`${method} got no reply within ${timeoutMs} ms`);
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/** The core's heartbeats stopped arriving on an open link: no frame came for `silentMs`, so the link is treated as gone. */
export class HcLinkSilentError extends Error {
  override readonly name = "HcLinkSilentError";
  readonly silentMs: number;

  constructor(silentMs: number) {
    super(`no heartbeat from the core for ${Math.round(silentMs / 1000)} s`);
    this.silentMs = silentMs;
  }
}
