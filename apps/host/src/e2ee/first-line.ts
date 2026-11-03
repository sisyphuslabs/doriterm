import { CloseCode, MAX_EARLY_BYTES } from "@doriface/crypto";
import type { AuthorizeIndex } from "../mesh/authorize-index.ts";
import type { DataHandler, Link } from "../link.ts";
import type { Peer } from "./authorize.ts";
import { hcLineOf } from "./hc-line.ts";

const LF = 0x0a;

/**
 * Section 7.6: a member's line may announce only its card's `hcId`, and a device may not announce any member's, so
 * no session re-points herdr's peer line for a member at itself. Returns why the session is refused, if it is.
 */
export function firstLineRefusal(
  peer: Peer,
  coreId: string | undefined,
  index: AuthorizeIndex | undefined,
): string | undefined {
  if (coreId === undefined) return undefined;
  if (peer.kind === "member") {
    return coreId === peer.member.hcId ? undefined : "core id does not match the member's card";
  }
  return index?.isMemberHcId(coreId) === true ? "a device announced a mesh member's core id" : undefined;
}

interface Refusal {
  readonly code: number;
  readonly reason: string;
}

/**
 * Section 7.6 against hc 0.1.17, which reads plain lines until a `hello` switches the connection to frames and takes
 * the peer's identity from that hello alone. Every plain line is held until it is whole (a line feed within
 * {@link MAX_EARLY_BYTES}) and read: the first must be a hello, every line must be a JSON-RPC request hc reads as
 * this host does, and every hello's `core.id` must pass `refusal`. A refused session is closed through `refuse` and
 * nothing from it reaches the handler. The lines read are delivered whole; from the framed hello on, data passes
 * straight through.
 */
export function gateHello(
  link: Link,
  refusal: (coreId: string | undefined) => string | undefined,
  refuse: (code: number, reason: string) => void,
): Link {
  let held = new Uint8Array(0);
  let state: "first" | "plain" | "framed" | "refused" = "first";
  const judge = (line: Uint8Array, first: boolean): Refusal | { readonly framed: boolean } => {
    const read = hcLineOf(line);
    if (read.kind === "malformed") return { code: CloseCode.CryptoFailure, reason: `an hc line: ${read.reason}` };
    if (read.kind === "call") {
      return first ? { code: CloseCode.CryptoFailure, reason: "the first hc line is not a hello" } : { framed: false };
    }
    const reason = refusal(read.coreId);
    return reason === undefined ? { framed: read.framed } : { code: CloseCode.UnknownDevice, reason };
  };
  const stop = ({ code, reason }: Refusal): void => {
    state = "refused";
    held = new Uint8Array(0);
    refuse(code, reason);
  };
  return {
    send: (bytes) => link.send(bytes),
    onClose: (handler) => link.onClose(handler),
    close: () => link.close(),
    onData(handler: DataHandler) {
      link.onData(async (bytes) => {
        if (state === "framed") return handler(bytes);
        if (state === "refused") return undefined;
        const joined = new Uint8Array(held.byteLength + bytes.byteLength);
        joined.set(held);
        joined.set(bytes, held.byteLength);
        let start = 0;
        let framed = false;
        while (!framed) {
          const end = joined.subarray(start, start + MAX_EARLY_BYTES).indexOf(LF);
          if (end === -1 && joined.byteLength - start < MAX_EARLY_BYTES) break;
          const verdict =
            end === -1
              ? { code: CloseCode.CryptoFailure, reason: `an hc line has no line feed within ${MAX_EARLY_BYTES} bytes` }
              : judge(joined.subarray(start, start + end), state === "first");
          if ("code" in verdict) return stop(verdict);
          state = "plain";
          framed = verdict.framed;
          start += end + 1;
        }
        if (framed) state = "framed";
        const ready = framed ? joined : joined.subarray(0, start);
        held = framed ? new Uint8Array(0) : joined.slice(start);
        return ready.byteLength === 0 ? undefined : handler(ready);
      });
    },
  };
}
