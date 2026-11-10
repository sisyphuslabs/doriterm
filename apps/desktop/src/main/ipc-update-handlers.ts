import { isSameOrigin } from "../config/origin.ts";
import { isUpdateChannel, type UpdateChannel, type UpdateStatus } from "../shared/update.ts";
import type { IpcSender } from "./ipc-handlers.ts";

/** The update channel and status (#1969); undefined members mean a build with no updater (a checkout). */
export interface UpdateDeps {
  readonly origin: string;
  readonly status: () => UpdateStatus | null;
  readonly channel: () => UpdateChannel | null;
  /** Keeps the channel for later launches and points the updater at it. */
  readonly setChannel: (channel: UpdateChannel) => boolean;
  readonly check: () => void;
}

export interface UpdateHandlers {
  status(event: IpcSender): UpdateStatus | null;
  channel(event: IpcSender): UpdateChannel | null;
  setChannel(event: IpcSender, candidate: unknown): boolean;
  check(event: IpcSender): void;
}

function assertAppFrame(event: IpcSender, origin: string): void {
  const url = event.senderFrame?.url ?? "";
  if (!isSameOrigin(url, origin)) throw new Error(`refused IPC from ${url === "" ? "a detached frame" : url}`);
}

/** Every handler refuses senders outside the app origin before doing anything, as ipc-handlers.ts does. */
export function updateHandlers(deps: UpdateDeps): UpdateHandlers {
  return {
    status(event) {
      assertAppFrame(event, deps.origin);
      return deps.status();
    },
    channel(event) {
      assertAppFrame(event, deps.origin);
      return deps.channel();
    },
    setChannel(event, candidate) {
      assertAppFrame(event, deps.origin);
      return isUpdateChannel(candidate) && deps.setChannel(candidate);
    },
    check(event) {
      assertAppFrame(event, deps.origin);
      deps.check();
    },
  };
}
