import { type Context, type Hono, type Next } from "hono";
import { checkBearer } from "./auth.ts";
import { AmbiguousDeviceError, type DeviceSurface, UnknownDeviceError } from "./device-surface.ts";
import type { McpSurface } from "./mcp-surface.ts";
import { LocalOnlyError } from "./mesh/local-only.ts";
import type { PairingOfferView } from "./pair-offer.ts";

/** The loopback pairing routes' answers; the app renders these, so they stay JSON-serialisable. */
export interface PairRoute {
  open(agent: boolean): Promise<PairAnswer>;
  state(): PairAnswer;
}

export type PairAnswer =
  | { readonly state: "pending"; readonly offer: PairingOfferView }
  | {
      readonly state: "paired";
      readonly device: { readonly name: string; readonly id: string; readonly pairedAt: string } | null;
    }
  | { readonly state: "approval" }
  | { readonly state: "expired" }
  | { readonly state: "none" };

export interface OwnerRoutes {
  readonly token: string;
  readonly pair?: PairRoute | undefined;
  readonly devices?: DeviceSurface | undefined;
  readonly mcpSurface?: McpSurface | undefined;
}

/**
 * The app-that-runs-the-host routes on the loopback listener (`/v1/pair`, `/v1/mcp`, `/v1/devices`), each behind the
 * same per-launch token as `/v1/hc`; never mounted on the LAN listener.
 */
export function mountOwnerRoutes(app: Hono, { token, pair, devices, mcpSurface }: OwnerRoutes): void {
  if (pair === undefined && devices === undefined && mcpSurface === undefined) return;
  const pairGate = async (c: Context, next: Next) => {
    if (!checkBearer(c.req.header("authorization"), token)) return c.text("missing or wrong doriface token", 401);
    await next();
    return undefined;
  };
  if (pair !== undefined) {
    app.get("/v1/pair", pairGate, (c) => c.json(pair.state()));
    // `?agent=1` opens an agent offer, whose device waits for an owner's approval before it is paired (#2939).
    app.post("/v1/pair", pairGate, async (c) => {
      try {
        return c.json(await pair.open(c.req.query("agent") === "1"));
      } catch (error) {
        if (error instanceof LocalOnlyError) return c.json({ error: error.message }, 409);
        throw error;
      }
    });
  }
  if (mcpSurface !== undefined) {
    app.get("/v1/mcp", pairGate, (c) => c.json(mcpSurface.state()));
    app.put("/v1/mcp", pairGate, async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const enabled = typeof body === "object" && body !== null ? Reflect.get(body, "enabled") : undefined;
      if (typeof enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
      return c.json(await mcpSurface.set(enabled));
    });
  }
  if (devices !== undefined) {
    app.get("/v1/devices", pairGate, (c) => c.json({ devices: devices.list() }));
    app.delete("/v1/devices/:id", pairGate, async (c) => {
      try {
        return c.json({ revoked: await devices.revoke(c.req.param("id") ?? "") });
      } catch (error) {
        if (error instanceof UnknownDeviceError) return c.json({ error: error.message }, 404);
        if (error instanceof AmbiguousDeviceError) return c.json({ error: error.message }, 409);
        throw error instanceof Error ? error : new Error(String(error));
      }
    });
  }
}
