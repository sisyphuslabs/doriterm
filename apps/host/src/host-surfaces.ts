import { DEFAULT_RELAY_URL } from "@doriface/crypto";
import type { MeshStatus } from "@doriface/protocol";
import { DeviceSurface } from "./device-surface.ts";
import type { e2eeDeps } from "./host-e2ee.ts";
import { HOST_VERSION, type HostOptions } from "./host-types.ts";
import { meshToolDeps } from "./mcp/mesh-deps.ts";
import { serveMcpLines } from "./mcp/serve.ts";
import { McpSurface } from "./mcp-surface.ts";
import { openOnCore, spawnHcLink } from "./mesh/hc-machines.ts";
import { PairOffers } from "./pair-surface.ts";
import type { HostPush } from "./push/host-push.ts";
import type { PushLink } from "./push/push-stream.ts";

export interface SurfaceParts {
  readonly options: HostOptions;
  readonly e2ee: ReturnType<typeof e2eeDeps> | undefined;
  readonly push: HostPush | undefined;
  readonly meshStatus: (() => MeshStatus | undefined) | undefined;
  readonly refreshMeshLines: () => Promise<void>;
}

/** What the gateway serves the app that runs the host and MCP clients: devices, the MCP stream and switch, pairing. */
export function ownerSurfaces({ options, e2ee, push, meshStatus, refreshMeshLines }: SurfaceParts) {
  // A revoke from the app or an MCP client is the same act as `devices revoke` on the control socket: the file loses
  // the device, the sessions of its key close, and its push subscription goes.
  const deviceSurface =
    e2ee === undefined
      ? undefined
      : new DeviceSurface({
          devices: e2ee.devices,
          changed: async () => {
            e2ee.hostMesh.sweepRoster();
            await e2ee.sessions.closeRevoked();
            push?.prune();
          },
        });
  return {
    mcp: (link: PushLink) =>
      serveMcpLines(link, {
        hostVersion: HOST_VERSION,
        mesh:
          e2ee === undefined || deviceSurface === undefined
            ? undefined
            : meshToolDeps({
                e2ee,
                devices: deviceSurface,
                status: async () => {
                  await refreshMeshLines();
                  return meshStatus?.();
                },
                relayUrl: options.relay?.url ?? DEFAULT_RELAY_URL,
              }),
        // Each MCP session gets its own connection to this host's core, as an hc session gets its own pipe.
        openHc: async () => {
          const target = {
            hc: options.hc,
            session: options.session,
            env: options.env,
            handshakeTimeoutMs: options.hcHandshakeTimeoutMs,
          };
          const child = spawnHcLink(target);
          try {
            return await openOnCore(child, target);
          } catch (error) {
            child.close();
            throw error;
          }
        },
      }),
    pair:
      e2ee === undefined
        ? undefined
        : new PairOffers({
            identity: e2ee.identity,
            pairing: e2ee.pairing,
            devices: e2ee.devices,
            open: () => e2ee.hostMesh.pairDevice(),
            relayUrl: options.relay?.url ?? DEFAULT_RELAY_URL,
          }),
    devices: deviceSurface,
    mcpSurface:
      e2ee === undefined
        ? undefined
        : new McpSurface({
            mcp: e2ee.mcp,
            devices: e2ee.devices,
            sessions: () => e2ee.sessions.mcpSessions(),
            changed: async () => {
              await e2ee.sessions.closeRevoked();
            },
          }),
  };
}
