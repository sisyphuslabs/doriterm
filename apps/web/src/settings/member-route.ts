import type { ConnectionPath } from "../connection/connect.ts";
import type { ConnectionState } from "../connection/store.ts";

export const PATH_WORD: Readonly<Record<ConnectionPath, string>> = {
  direct: "Direct",
  relay: "Relay",
  loopback: "Loopback",
};

export interface MemberRoute {
  readonly path: ConnectionPath;
  readonly line: string;
}

const addressOf = (url: string): string => (URL.canParse(url) ? new URL(url).host : url);

/**
 * How this device reaches one machine right now, taken from the open session's own transport (`connect.ts` reports
 * which one carried it), never assumed. The direct `/v1/e2ee` path and the relay both carry a Noise session, so both
 * are end-to-end encrypted; the loopback gateway is the plaintext development path. A machine with no open session has
 * no route to name, so it gets none (#1550).
 */
export function memberRouteOf(
  state: ConnectionState,
  addresses: { readonly relayUrl: string; readonly directUrl: string; readonly loopbackUrl: string },
): MemberRoute | undefined {
  if (state.phase !== "open") return undefined;
  switch (state.path) {
    case "direct":
      return {
        path: "direct",
        line: `Direct to ${addressOf(addresses.directUrl) || "its LAN address"} · end-to-end encrypted`,
      };
    case "relay":
      return { path: "relay", line: `Through the relay ${addressOf(addresses.relayUrl)} · end-to-end encrypted` };
    case "loopback":
      return { path: "loopback", line: `Loopback ${addressOf(addresses.loopbackUrl)} · plain text, for development` };
  }
}
