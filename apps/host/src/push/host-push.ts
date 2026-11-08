import type { HcTarget } from "../mesh/hc-machines.ts";
import type { DeviceStore } from "../state/devices.ts";
import type { MeshStore } from "../state/mesh.ts";
import { type CoreFeed, startCoreFeed } from "./core-feed.ts";
import { PushService } from "./push-service.ts";
import { type PushLink, servePushStream } from "./push-stream.ts";
import { LOOPBACK_OWNER, SubscriptionStore } from "./subscriptions.ts";
import { loadVapidKey } from "./vapid-key.ts";

export interface HostPush {
  /** Serves one device's push stream: the E2EE session's, or the loopback `/v1/push` socket's. */
  serve(link: PushLink, owner: string): void;
  /** Drops the subscriptions of devices no longer paired (a revoke). */
  prune(): void;
  /** Settles once the core feed's `hc connect` child, if it started one, has exited. */
  stop(): Promise<void>;
  /** Kills the core feed's child if it has not exited, and returns the pids it killed. */
  kill(): readonly number[];
}

export interface HostPushOptions {
  readonly stateDir: string;
  readonly hostId: string;
  readonly devices: DeviceStore;
  readonly mesh?: MeshStore | undefined;
  readonly hc: HcTarget;
  readonly extraOrigins?: readonly string[] | undefined;
  readonly log: (line: string) => void;
}

/**
 * The host's web push: the VAPID key, the subscriptions, and a line to this host's core that starts with the first
 * subscription, so a host nobody subscribed to starts no extra `hc connect`.
 */
export async function startHostPush(options: HostPushOptions): Promise<HostPush> {
  const { stateDir, devices, log } = options;
  const subscriptions = new SubscriptionStore(stateDir);
  const paired = (): ReadonlySet<string> =>
    new Set([
      ...devices.list().map((device) => device.clientStaticPub),
      ...(options.mesh?.authorizeIndex()?.clients() ?? []).flatMap((client) =>
        client.devicePub === undefined ? [] : [client.devicePub],
      ),
    ]);
  const service = new PushService({
    hostId: options.hostId,
    vapid: await loadVapidKey(stateDir),
    subscriptions,
    paired,
    deviceName: (owner) =>
      owner === LOOPBACK_OWNER
        ? "this computer"
        : (devices.list().find((device) => device.clientStaticPub === owner)?.name ??
          options.mesh?.authorizeIndex()?.client(owner)?.name ??
          "a paired device"),
    extraOrigins: options.extraOrigins,
    onSubscribe: () => follow(),
    log,
  });
  let feed: CoreFeed | undefined;
  /** Follows the core from the first subscription on; resolves once the feed has its baseline. */
  function follow(): Promise<void> {
    if (feed === undefined && subscriptions.list().length > 0) feed = startCoreFeed(options.hc, service, log);
    return feed?.ready ?? Promise.resolve();
  }
  const prune = (): void => {
    try {
      subscriptions.keepOwners(paired());
    } catch (error) {
      log(`push: cannot prune the subscriptions: ${String(error)}`);
    }
  };
  prune();
  void follow();
  return {
    serve: (link, owner) => servePushStream(link, owner, service),
    prune,
    stop() {
      return feed?.stop() ?? Promise.resolve();
    },
    kill: () => feed?.kill() ?? [],
  };
}
