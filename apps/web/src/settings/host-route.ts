import type { ConnectionSettings } from "../connection/settings.ts";
import { directPathAvailable } from "../connection/direct-switch.ts";

/** How this app reaches its host: the relay, or the plaintext loopback gateway a development build uses. */
export type HostRoute = "relay" | "loopback";

export interface HostRouteText {
  readonly route: HostRoute;
  /** The relay's host name or the loopback address, as a person reads it. */
  readonly address: string;
  /** One line under the host's name, or undefined while no host is paired to name a route to. */
  readonly label: string | undefined;
}

type RouteSettings = Pick<ConnectionSettings, "mode" | "relayUrl" | "directUrl" | "loopbackUrl" | "hostId">;

/** A relay or an origin as people read it: its host, without the scheme. */
const addressOf = (url: string): string => (URL.canParse(url) ? new URL(url).host : url);

/**
 * The relay and the direct `/v1/e2ee` race both carry a Noise session, so both are end-to-end encrypted, and a paired
 * host with a known direct address may answer either way: the label names both rather than claiming one. Only the
 * desktop shell with the direct path switched on can dial a direct address (#1381 §8, #2070), so only it is told about
 * one; everywhere else the label names the relay alone, whatever address an older file holds. The loopback gateway is
 * the plaintext development path the connection settings
 * already label as such. An app with no host paired has no route to name, so it gets no label at all rather than the
 * relay it would use once paired (review of #772).
 */
export function hostRouteOf(settings: RouteSettings, directPath: boolean = directPathAvailable()): HostRouteText {
  if (settings.mode === "loopback") {
    const address = addressOf(settings.loopbackUrl);
    return { route: "loopback", address, label: `Loopback ${address} · plain text, for development` };
  }
  const address = addressOf(settings.relayUrl);
  if (settings.hostId === "") return { route: "relay", address, label: undefined };
  const direct =
    !directPath || settings.directUrl === "" ? "" : `, or direct to ${addressOf(settings.directUrl)} when it answers`;
  return { route: "relay", address, label: `Through the relay ${address}${direct} · end-to-end encrypted` };
}
