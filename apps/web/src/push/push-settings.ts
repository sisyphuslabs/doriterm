import { DEFAULT_PUSH_PREFS, type PushHostLine, type PushPrefs } from "@doriface/protocol";
import { type ConnectionSettings, isConfigured } from "../connection/settings.ts";
import { connectionStore } from "../connection/store.ts";
import { MoveQueue } from "./move-queue.ts";
import { pushChannel } from "./push-channel.ts";
import { recordPushMove } from "./push-move-probe.ts";
import {
  loadPushPrefs,
  loadPushRoute,
  type PushRoute,
  routeOf,
  sameRoute,
  savePushPrefs,
  savePushRoute,
} from "./push-route.ts";
import { browserScope, type PushSupport, pushSupport } from "./push-support.ts";
import { reconcile } from "./reconcile.ts";
import { pushRegistrar } from "./registrar.ts";

/** A feed the desktop app could not follow and tries again: why, and how long until the next try. */
export interface FeedRetry {
  readonly reason: string;
  readonly inMs: number;
}

export interface PushView {
  readonly support: PushSupport;
  /**
   * The browser's notification permission, or the OS's authorization of the desktop app as the browser would name it
   * (`default` while the OS has not asked yet); null where none can be read.
   */
  readonly permission: NotificationPermission | null;
  readonly on: boolean;
  readonly prefs: PushPrefs;
  readonly busy: boolean;
  readonly error: string | null;
  /** Set once a test notice was handed to the push service. */
  readonly tested: boolean;
  /** Desktop only: the feed subscription that failed and is being retried; null while it stands or is not wanted. */
  readonly retry: FeedRetry | null;
  /** Desktop only: agents already in a state this device asked to hear about, which the feed announces no more. */
  readonly waiting: number | null;
}

const MOVE = "move notifications to the new host";

const INITIAL: PushView = {
  support: "unsupported",
  permission: null,
  on: false,
  prefs: DEFAULT_PUSH_PREFS,
  busy: true,
  error: null,
  tested: false,
  retry: null,
  waiting: null,
};

function expect(reply: PushHostLine, what: string): void {
  if (reply.t === "error") throw new Error(`The host refused to ${what}: ${reply.reason}`);
}

const failure = (what: string, error: unknown): string =>
  `Could not ${what}. ${error instanceof Error ? error.message : String(error)}`;

/** Settings > Notifications: this device's permission, its subscription on the host, and what it asks to hear. */
class PushSettings {
  #view: PushView = INITIAL;
  readonly #listeners = new Set<() => void>();
  /** Moves run one at a time (see `retarget`). */
  readonly #moves = new MoveQueue();
  /**
   * Why the last move failed, shown until another move settles or Turn on/off succeeds. Opening Notifications reads the
   * settings again, and that read must not hide that notifications stayed with the old host (#890).
   */
  #unmoved: string | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  get view(): PushView {
    return this.#view;
  }

  /**
   * Reads the state; never asks for permission. Notifications that were turned on here stay on: a subscription the
   * browser dropped is made again, and one the host lost is handed to it again (`reconcile`).
   */
  async load(): Promise<void> {
    const support = pushSupport(browserScope());
    const permission = support === "supported" ? await pushRegistrar().permission() : null;
    this.#set({ support, permission });
    if (support !== "supported") return this.#set({ busy: false });
    await this.#run("read the notification settings", async () => {
      const route = await loadPushRoute();
      const granted = permission === "granted";
      if (!granted || route === undefined) {
        if (route !== undefined) await savePushRoute(null);
        return this.#set({ on: false });
      }
      const subscription = await pushRegistrar().current();
      const ready = await pushChannel.requestOnce({ t: "hello" }, route);
      if (ready.t !== "ready") throw new Error("the host did not answer");
      const held = ready.subscriptions.find((entry) => entry.endpoint === subscription?.endpoint);
      const action = reconcile({
        granted,
        routeSaved: true,
        browser: subscription === null ? null : { keyMatches: subscription.matches(ready.vapidKey) },
        held: held !== undefined,
      });
      const prefs = held?.prefs ?? (await loadPushPrefs()) ?? DEFAULT_PUSH_PREFS;
      if (action !== "on") await this.#register(route, prefs, ready.vapidKey);
      else await savePushPrefs(prefs);
      this.#set({ on: true, prefs });
    });
  }

  /** Runs from the Turn on click: the only place this app asks for the notification permission. */
  async turnOn(): Promise<void> {
    const permission = await pushRegistrar().requestPermission();
    this.#set({ permission });
    if (permission !== "granted") return;
    await this.#run("turn notifications on", async () => {
      await this.#register(routeOf(connectionStore.settings), this.#view.prefs);
      this.#settled(null);
      this.#set({ on: true });
    });
  }

  /** Removes the subscription from the host and the browser; the permission itself stays the browser's. */
  async turnOff(): Promise<void> {
    await this.#run("turn notifications off", async () => {
      const registrar = pushRegistrar();
      const subscription = await registrar.current();
      if (subscription !== null) {
        await pushChannel.requestOnce({ t: "unsubscribe", endpoint: subscription.endpoint }).catch(() => undefined);
        await registrar.unsubscribe();
      }
      await savePushRoute(null);
      this.#settled(null);
      this.#set({ on: false, tested: false });
    });
  }

  /**
   * The connection moved to another host or token: the old host stops notifying this browser, the saved route (and the
   * loopback token in it) is dropped, and notifications that were on are registered with the new host. One move runs
   * at a time: one connection change can change the settings twice (the new host's name arrives with its hello), and a
   * second move that read the saved route while the first was still registering redid the whole move beside it (#780).
   */
  retarget(settings: ConnectionSettings): Promise<void> {
    const moved = this.#moves.run(() => this.#retarget(settings));
    recordPushMove(this.#moves.idle);
    return moved;
  }

  async #retarget(next: ConnectionSettings): Promise<void> {
    const route = await loadPushRoute().catch(() => undefined);
    if (route === undefined) return this.#settled(null);
    let target: PushRoute | undefined;
    try {
      target = isConfigured(next) ? routeOf(next) : undefined;
    } catch (error) {
      // A gateway that is not an address (#890): the move fails in view, and the old route stays.
      return this.#settled(failure(MOVE, error));
    }
    if (target !== undefined && sameRoute(route, target)) return this.#settled(null);
    const failed = await this.#run(MOVE, async () => {
      const registrar = pushRegistrar();
      const subscription = await registrar.current();
      if (subscription !== null) {
        await pushChannel
          .requestOnce({ t: "unsubscribe", endpoint: subscription.endpoint }, route)
          .catch(() => undefined);
      }
      await savePushRoute(null);
      pushChannel.reset();
      if (target === undefined || (await registrar.permission()) !== "granted") return this.#set({ on: false });
      await this.#register(target, (await loadPushPrefs()) ?? this.#view.prefs);
      this.#set({ on: true });
    });
    this.#settled(failed);
  }

  async setPrefs(prefs: PushPrefs): Promise<void> {
    const before = this.#view.prefs;
    this.#set({ prefs });
    await this.#run("save the notification settings", async () => {
      const subscription = await pushRegistrar().current();
      if (subscription === null) return;
      const reply = await pushChannel.requestOnce({ t: "prefs", endpoint: subscription.endpoint, prefs });
      if (reply.t === "error") this.#set({ prefs: before });
      expect(reply, "save the settings");
      await savePushPrefs(prefs);
    });
  }

  async test(): Promise<void> {
    await this.#run("send a test notification", async () => {
      const subscription = await pushRegistrar().current();
      if (subscription === null) throw new Error("this device has no subscription");
      expect(await pushChannel.requestOnce({ t: "test", endpoint: subscription.endpoint }), "send a test notification");
      this.#set({ tested: true });
    });
  }

  /**
   * Subscribes this device with the host's VAPID key (again, when it holds none or one for another key), hands the
   * subscription to the host, and saves the route and preferences the service worker or the app needs.
   */
  async #register(route: PushRoute, prefs: PushPrefs, knownKey?: string): Promise<void> {
    let vapidKey = knownKey;
    if (vapidKey === undefined) {
      const ready = await pushChannel.requestOnce({ t: "hello" }, route);
      if (ready.t !== "ready") throw new Error("the host did not answer");
      vapidKey = ready.vapidKey;
    }
    const subscription = await pushRegistrar().subscribe(vapidKey);
    expect(await pushChannel.requestOnce({ t: "subscribe", subscription, prefs }, route), "subscribe");
    await savePushRoute(route);
    await savePushPrefs(prefs);
  }

  /** Runs one step with the view busy; answers why it failed, or null. */
  async #run(what: string, step: () => Promise<void>): Promise<string | null> {
    this.#set({ busy: true, error: this.#unmoved });
    try {
      await step();
      this.#set({ busy: false });
      return null;
    } catch (error) {
      const message = failure(what, error);
      this.#set({ busy: false, error: message });
      return message;
    }
  }

  /** A move or an explicit on/off action settled; successful actions clear the last move failure. */
  #settled(unmoved: string | null): void {
    const shown = this.#view.error === this.#unmoved;
    this.#unmoved = unmoved;
    if (shown || unmoved !== null) this.#set({ error: unmoved });
  }

  #set(change: Partial<PushView>): void {
    this.#view = { ...this.#view, ...change };
    for (const listener of this.#listeners) listener();
  }
}

export const pushSettings = new PushSettings();

/** Keeps the saved push route with the connection: a change of host or token re-registers notifications there. */
export function followConnection(): void {
  let settings = connectionStore.settings;
  let path = connectionStore.state.phase === "open" ? connectionStore.state.path : undefined;
  connectionStore.subscribe(() => {
    const state = connectionStore.state;
    const next = state.phase === "open" ? state.path : undefined;
    // Push follows the main connection's path: a switch closes the open stream and reopens it on the new one (#446 §3).
    if (next !== path) {
      path = next;
      pushChannel.reset();
    }
    if (connectionStore.settings === settings) return;
    settings = connectionStore.settings;
    void pushSettings.retarget(settings);
  });
}
