import {
  isPairedDevice,
  type LocalHostEndpoint,
  type PairedDevice,
  type PairedDevicesAnswer,
  type RevokeDeviceAnswer,
} from "../shared/bridge.ts";

/** Long enough for a host still starting, short enough to keep Settings responsive. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** The loopback gateway answers plain HTTP on the same port as its websocket; the device routes sit beside /v1/hc. */
export function devicesEndpointUrl(endpoint: LocalHostEndpoint, id?: string): string {
  const url = new URL(endpoint.url);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = id === undefined ? "/v1/devices" : `/v1/devices/${encodeURIComponent(id)}`;
  url.search = "";
  return url.toString();
}

const unavailable = (reason: string): { readonly state: "unavailable"; readonly reason: string } => ({
  state: "unavailable",
  reason,
});

/** A refusal every device route shares: a host too old for the routes, a token this launch no longer accepts. */
function routeRefusal(status: number): string | undefined {
  if (status === 404) return "This doriface-host is too old to list its paired devices.";
  if (status === 401) return "This computer's host refused the request; start it again.";
  return status >= 400 ? `This computer's host answered ${status}.` : undefined;
}

/** A refusal's own words, when the host sent them: a shared short id names the device it could not pick. */
function refusalOf(status: number, body: unknown): string {
  const error = typeof body === "object" && body !== null ? Reflect.get(body, "error") : undefined;
  return typeof error === "string" && error !== ""
    ? error
    : (routeRefusal(status) ?? `This computer's host answered ${status}.`);
}

function devicesOf(value: unknown, key: string): readonly PairedDevice[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const devices: unknown = Reflect.get(value, key);
  return Array.isArray(devices) && devices.every(isPairedDevice) ? devices : undefined;
}

/**
 * This computer's paired devices over the token-guarded loopback gateway. The host is another process whose answer is
 * untrusted: every field is checked, and every failure is a value Settings can say out loud.
 */
export async function requestPairedDevices(
  endpoint: LocalHostEndpoint,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<PairedDevicesAnswer> {
  let response: Response;
  try {
    response = await fetch(devicesEndpointUrl(endpoint), {
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  const refusal = routeRefusal(response.status);
  if (refusal !== undefined) return unavailable(refusal);
  const body: unknown = await response.json().catch(() => null);
  const devices = devicesOf(body, "devices");
  return devices === undefined
    ? unavailable("This computer's host sent a device list this app does not understand.")
    : { state: "listed", devices };
}

/**
 * Revokes one paired device and answers the list as it stands after: the host closes that device's live sessions
 * (close code 4401) and refuses its key from the next handshake, so this computer stops reaching that phone or browser.
 */
export async function revokePairedDevice(
  endpoint: LocalHostEndpoint,
  id: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RevokeDeviceAnswer> {
  let response: Response;
  try {
    response = await fetch(devicesEndpointUrl(endpoint, id), {
      method: "DELETE",
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  if (response.status === 404) {
    const devices = await requestPairedDevices(endpoint, timeoutMs);
    return devices.state === "listed" ? { state: "not-found", devices: devices.devices } : devices;
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    return unavailable(refusalOf(response.status, body));
  }
  const body: unknown = await response.json().catch(() => null);
  const revoked = devicesOf(body, "revoked");
  if (revoked === undefined || revoked.length === 0) {
    return unavailable("This computer's host sent a revoke answer this app does not understand.");
  }
  const devices = await requestPairedDevices(endpoint, timeoutMs);
  if (devices.state !== "listed") return devices;
  const [device] = revoked;
  if (device === undefined) return unavailable("This computer's host named no device it revoked.");
  return { state: "revoked", device, devices: devices.devices };
}
