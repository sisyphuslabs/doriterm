import { base64urlDecode, fingerprintOf } from "@doriface/crypto";
import { type DeviceStore, deviceIdOf } from "./state/devices.ts";
import type { McpSwitch } from "./state/mcp-switch.ts";

/** One live MCP session as a surface shows it; `name` is null for a mesh client, which this computer did not pair. */
export interface McpClientView {
  readonly id: string;
  readonly name: string | null;
}

export interface McpState {
  readonly enabled: boolean;
  readonly clients: readonly McpClientView[];
}

export interface McpSurfaceOptions {
  readonly mcp: McpSwitch;
  readonly devices: DeviceStore;
  /** The keys of the live MCP sessions (`LiveSessions.mcpSessions`). */
  readonly sessions: () => readonly { readonly key: string }[];
  /** Runs after the switch went off: the MCP sessions close (4401), as `doriface-host mcp off` has them closed. */
  readonly changed: () => Promise<void>;
}

/**
 * This computer's MCP switch and who is connected through it, for the app that runs the host: what
 * `doriface-host mcp on|off|status` does from a terminal. A client is disconnected by revoking its device.
 */
export class McpSurface {
  readonly #options: McpSurfaceOptions;

  constructor(options: McpSurfaceOptions) {
    this.#options = options;
  }

  state(): McpState {
    const { mcp, devices, sessions } = this.#options;
    const paired = new Map(devices.list().map((device) => [device.clientStaticPub, device]));
    const clients = sessions().map(({ key }) => {
      const device = paired.get(key);
      return device === undefined
        ? { id: fingerprintOf(base64urlDecode(key)).replaceAll(" ", "").slice(0, 8), name: null }
        : { id: deviceIdOf(device), name: device.name };
    });
    return { enabled: mcp.enabled(), clients };
  }

  async set(enabled: boolean): Promise<McpState> {
    this.#options.mcp.setEnabled(enabled);
    if (!enabled) await this.#options.changed();
    return this.state();
  }
}
