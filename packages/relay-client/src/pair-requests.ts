import { LinkClosedError } from "./link.ts";
import { decodePairSlotAck, PairSlotAckStatus } from "./wire/index.ts";

/**
 * "registered-unsigned": the relay refused the signed form as malformed (a relay older than contract v1.8), so the
 * host registered the unsigned form; clients from v1.8 on refuse that slot's answer.
 */
export type PairSlotResult = "registered" | "registered-unsigned" | "taken";

/** The relay answered a PAIR_SLOT request with status 2 (malformed). */
export class PairSlotMalformedError extends Error {
  override readonly name = "PairSlotMalformedError";
}

/** What one PAIR_SLOT_ACK settles a request with. */
export type AckResult = "registered" | "taken";

/** Sends the signed PAIR_SLOT; a relay that acks it malformed (older than contract v1.8) gets the unsigned one. */
export async function signedOrUnsigned(
  send: (frame: Uint8Array<ArrayBuffer>) => Promise<AckResult>,
  signed: Uint8Array<ArrayBuffer>,
  unsigned: Uint8Array<ArrayBuffer>,
): Promise<PairSlotResult> {
  try {
    return await send(signed);
  } catch (error) {
    if (!(error instanceof PairSlotMalformedError)) throw error;
  }
  return (await send(unsigned)) === "registered" ? "registered-unsigned" : "taken";
}

interface Waiter {
  readonly resolvers: PromiseWithResolvers<AckResult>;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * PAIR_SLOT requests the uplink sent, waiting for the relay's PAIR_SLOT_ACK. At most one request per slot waits at a
 * time, and one without a reply in `timeoutMs` is dropped, so a lost reply never blocks later requests.
 */
export class PairSlotRequests {
  readonly #waiting = new Map<string, Waiter>();

  wait(slot: string, timeoutMs: number): Promise<AckResult> {
    if (this.#waiting.has(slot)) {
      return Promise.reject(new Error(`a PAIR_SLOT request for ${slot} is already waiting for the relay`));
    }
    const resolvers = Promise.withResolvers<AckResult>();
    const timer = setTimeout(() => {
      this.#waiting.delete(slot);
      resolvers.reject(new Error(`no PAIR_SLOT reply for ${slot} within ${timeoutMs} ms`));
    }, timeoutMs);
    this.#waiting.set(slot, { resolvers, timer });
    return resolvers.promise;
  }

  /** Settles the request a PAIR_SLOT_ACK payload answers; false when the ack itself is malformed. */
  settle(payload: Uint8Array): boolean {
    const ack = decodePairSlotAck(payload);
    if (ack === undefined) return false;
    const waiter = this.#waiting.get(ack.slot);
    this.#waiting.delete(ack.slot);
    if (waiter === undefined) return true;
    clearTimeout(waiter.timer);
    if (ack.status === PairSlotAckStatus.Malformed) {
      waiter.resolvers.reject(
        new PairSlotMalformedError(`the relay refused the PAIR_SLOT request for ${ack.slot} as malformed`),
      );
    } else {
      waiter.resolvers.resolve(ack.status === PairSlotAckStatus.Registered ? "registered" : "taken");
    }
    return true;
  }

  failAll(reason: string): void {
    for (const { resolvers, timer } of this.#waiting.values()) {
      clearTimeout(timer);
      resolvers.reject(new LinkClosedError(reason));
    }
    this.#waiting.clear();
  }
}
