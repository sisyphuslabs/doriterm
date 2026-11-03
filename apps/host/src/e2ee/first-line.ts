import { MAX_EARLY_BYTES } from "@doriface/crypto";
import type { AuthorizeIndex } from "../mesh/authorize-index.ts";
import type { DataHandler, Link } from "../link.ts";
import type { Peer } from "./authorize.ts";

const LF = 0x0a;

/**
 * The `core.id` an hc peer announces in its first line, `{"method":"hello","params":{"core":{"id":…}}}`. herdr's
 * machine dial sends it; its `machine.add` probe and a plain client send a hello without one, and get undefined.
 */
export function coreIdOf(line: Uint8Array): string | undefined {
  let message: unknown;
  try {
    message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
  } catch {
    return undefined;
  }
  if (typeof message !== "object" || message === null || !("method" in message) || message.method !== "hello") {
    return undefined;
  }
  const params = "params" in message ? message.params : undefined;
  const core = typeof params === "object" && params !== null && "core" in params ? params.core : undefined;
  const id = typeof core === "object" && core !== null && "id" in core ? core.id : undefined;
  return typeof id === "string" ? id : undefined;
}

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

/**
 * Holds `link`'s data until its first line (or {@link MAX_EARLY_BYTES} without a line feed) and asks `refusal` about
 * it; a refused session is closed through `refuse` and nothing reaches the handler. Nothing after the first line is
 * read. Everything held is then delivered in one chunk, and later data passes straight through.
 */
export function gateFirstLine(
  link: Link,
  refusal: (coreId: string | undefined) => string | undefined,
  refuse: (reason: string) => void,
): Link {
  let held = new Uint8Array(0);
  let decided = false;
  return {
    send: (bytes) => link.send(bytes),
    onClose: (handler) => link.onClose(handler),
    close: () => link.close(),
    onData(handler: DataHandler) {
      link.onData(async (bytes) => {
        if (decided) return handler(bytes);
        const joined = new Uint8Array(held.byteLength + bytes.byteLength);
        joined.set(held);
        joined.set(bytes, held.byteLength);
        held = joined;
        const end = held.subarray(0, MAX_EARLY_BYTES).indexOf(LF);
        if (end === -1 && held.byteLength < MAX_EARLY_BYTES) return undefined;
        decided = true;
        const reason = refusal(end === -1 ? undefined : coreIdOf(held.subarray(0, end)));
        const first = held;
        held = new Uint8Array(0);
        if (reason !== undefined) return refuse(reason);
        return handler(first);
      });
    },
  };
}
