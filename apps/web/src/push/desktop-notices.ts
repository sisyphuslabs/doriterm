import type { EventFeed, HcConnection } from "@doriface/client";
import {
  DEFAULT_PUSH_PREFS,
  type HcEvent,
  NOTICE_EVENTS,
  type NoticeContext,
  noticeContextOf,
  noticeMachineId,
  parsePushClientLine,
  type PushPrefs,
  readScreenPrompt,
} from "@doriface/protocol";
import { type ConnectionState, connectionStore } from "../connection/store.ts";
import { type NoticeBridge, noticeBridge, permissionOf } from "./notice-bridge.ts";
import { NoticeTrigger, type Trigger, wanted } from "./notice-trigger.ts";
import type { NoticeStep, PushView } from "./push-settings.ts";
import { guardedLocalStorage } from "../storage/guarded.ts";

export const DESKTOP_NOTICES_KEY = "doriface.desktop-notices";

export interface SavedNotices {
  readonly on: boolean;
  readonly prefs: PushPrefs;
}

/** What Settings saved here; anything unreadable is notifications off with every event. */
export function parseSavedNotices(raw: string | null): SavedNotices {
  const off: SavedNotices = { on: false, prefs: DEFAULT_PUSH_PREFS };
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (typeof value !== "object" || value === null) return off;
    const prefs: unknown = Reflect.get(value, "prefs");
    const line = parsePushClientLine(JSON.stringify({ t: "prefs", endpoint: "https://prefs.invalid/", prefs }));
    return { on: Reflect.get(value, "on") === true, prefs: line.t === "prefs" ? line.prefs : DEFAULT_PUSH_PREFS };
  } catch {
    return off;
  }
}

export interface NoticeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type Schedule = (step: () => void, ms: number) => () => void;

export interface DesktopNoticesOptions {
  readonly bridge: NoticeBridge;
  readonly storage: NoticeStorage;
  readonly connection: Pick<typeof connectionStore, "state" | "subscribe">;
  /** The connected host as people name it, for a notice about one of its own terminals; empty when it has none. */
  readonly hostName?: () => string;
  readonly now?: () => number;
  readonly schedule?: Schedule;
}

/** A failed subscribe is tried again after 1 s, then twice as long each time, never later than this. */
export const MAX_RETRY_MS = 30_000;

export const retryDelay = (attempt: number): number => Math.min(1_000 * 2 ** attempt, MAX_RETRY_MS);

/** A refused notice is reported on the tab at most this often: an agent flapping is one error, not one per event. */
export const REFUSAL_REPORT_MS = 60_000;

const timers: Schedule = (step, ms) => {
  const handle = setTimeout(step, ms);
  return () => clearTimeout(handle);
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** How long a notification waits to be told what its terminal is before it shows without it. */
export const DESCRIBE_TIMEOUT_MS = 2_000;

/**
 * What a notification can say about its terminal (#1908), read off this app's own connection: the terminal record,
 * and for a question or a permission the dialog on its screen now.
 */
export async function describeHit(
  connection: Pick<HcConnection, "call">,
  hit: Trigger,
  hostName: string,
): Promise<NoticeContext> {
  const options = { timeoutMs: DESCRIBE_TIMEOUT_MS };
  const asks = hit.kind === "input" || hit.kind === "permission";
  const [terminal, screen] = await Promise.all([
    connection.call("terminal.get", { terminal: hit.terminal }, options),
    asks
      ? connection.call("terminal.read", { terminal: hit.terminal, lines: 0 }, options).then((read) => read.text)
      : undefined,
  ]);
  const prompt = screen === undefined ? undefined : readScreenPrompt(terminal.status?.app ?? "", screen);
  return noticeContextOf(terminal, hit.machine ?? hostName, prompt);
}

/**
 * Settings > Notifications in the desktop app: native notifications from this app's own event feed, on the same
 * triggers, kinds and machine mutes as web push. They come while the app runs, its window in the background or hidden.
 */
export class DesktopNotices {
  readonly #options: DesktopNoticesOptions;
  readonly #listeners = new Set<() => void>();
  readonly #trigger = new NoticeTrigger();
  #view: PushView;
  #connection: HcConnection | null = null;
  #feed: EventFeed | undefined;
  #opening: Promise<void> | undefined;
  #shown: string | null = null;
  #attempts = 0;
  #pendingRetry: (() => void) | null = null;
  #refusalReportedAt: number | null = null;
  /** Notices show in the order the feed told them, each after the one before, whatever their lookups take. */
  #shows: Promise<void> = Promise.resolve();

  constructor(options: DesktopNoticesOptions) {
    this.#options = options;
    const saved = parseSavedNotices(options.storage.getItem(DESKTOP_NOTICES_KEY));
    this.#view = {
      support: "supported",
      permission: null,
      busy: null,
      error: null,
      tested: false,
      retry: null,
      waiting: null,
      ...saved,
    };
    options.connection.subscribe(() => this.#follow());
    this.#follow();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  get view(): PushView {
    return this.#view;
  }

  /** Reads what this system can show and whether it allows this app to; never asks, the OS does at the first notice. */
  async load(): Promise<void> {
    await this.#run("check-again", "read the notification settings", async () => {
      const [supported, authorization] = await Promise.all([
        this.#options.bridge.supported(),
        this.#options.bridge.permission(),
      ]);
      this.#set({ support: supported ? "supported" : "desktop-app", permission: permissionOf(authorization) });
    });
  }

  async turnOn(): Promise<void> {
    this.#save({ on: true });
  }

  async turnOff(): Promise<void> {
    this.#save({ on: false, tested: false });
  }

  async setPrefs(prefs: PushPrefs): Promise<void> {
    this.#save({ prefs });
    this.#count();
  }

  /** Shows a test notice only past the gates an agent's notice passes, so a pass means one would show. */
  async test(): Promise<void> {
    await this.#run("test", "send a test notification", async () => {
      await this.#opening;
      const refusal = this.#testRefusal();
      if (refusal !== undefined) throw new Error(refusal);
      const answer = await this.#options.bridge.show({ kind: "test", terminal: null });
      if (!answer.accepted) throw new Error(answer.reason);
      this.#set({ tested: true });
    });
  }

  #testRefusal(): string | undefined {
    const { on, prefs, retry } = this.#view;
    if (!on) return "Notifications are off.";
    if (this.#feed === undefined) {
      return retry === null
        ? "Doriterm is not following the agents yet: it is not connected to the host."
        : `Doriterm is not following the agents: ${retry.reason}.`;
    }
    if (!NOTICE_EVENTS.some((kind) => prefs.events[kind]))
      return "Every event is turned off, so no agent would notify.";
    // `local` is the connected host's core, not the computer this app runs on (#1121): it is heard beside every added
    // machine the feed reports, and only every one of them muted leaves no agent notice that would show (#1120).
    const machines = new Set<string | undefined>([undefined, ...this.#trigger.machines()]);
    if (![...machines].every((machine) => prefs.muted.includes(noticeMachineId(machine)))) return undefined;
    // Only machines running a terminal right now are counted, so the refusal says so: one added later still notifies (#1893).
    return machines.size === 1
      ? `Notifications from ${this.#hostName()} are turned off, and no other machine is running a terminal right now.`
      : "Notifications from every machine running a terminal right now are turned off.";
  }

  /** The connected host's core as its hello names it: the machine `local` stands for. */
  #hostName(): string {
    const state = this.#options.connection.state;
    return state.phase === "open" ? state.connection.hello.core.name : "the host";
  }

  /** The pane this window shows focused and visible, or null: no notification comes about it. */
  focus(terminal: string | null): void {
    this.#shown = terminal;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #heard(event: HcEvent): void {
    const hit = this.#trigger.event(event, this.#now());
    this.#count();
    if (hit === undefined || !this.#view.on || !wanted(hit, this.#view.prefs, this.#shown)) return;
    const connection = this.#connection;
    const described =
      connection === null
        ? Promise.resolve(undefined)
        : describeHit(connection, hit, this.#options.hostName?.() ?? "").catch(() => undefined);
    this.#shows = this.#shows.then(async () => this.#show(hit, await described));
  }

  /** A notice whose terminal could not be read in time shows all the same, with the fixed text. */
  async #show(hit: Trigger, context: NoticeContext | undefined): Promise<void> {
    try {
      const answer = await this.#options.bridge.show({
        kind: hit.kind,
        terminal: hit.terminal,
        ...(context === undefined ? {} : { context }),
      });
      if (!answer.accepted) this.#refused(answer.reason);
    } catch (error) {
      this.#refused(message(error));
    }
  }

  #refused(reason: string): void {
    const now = this.#now();
    if (this.#refusalReportedAt !== null && now - this.#refusalReportedAt < REFUSAL_REPORT_MS) return;
    this.#refusalReportedAt = now;
    this.#set({ error: `Could not show a notification. ${reason}` });
  }

  /** How many agents the feed last reported in a state this device asked to hear about; null without a feed. */
  #count(): void {
    const waiting =
      this.#feed === undefined
        ? null
        : this.#trigger.waiting().filter((hit) => wanted(hit, this.#view.prefs, null)).length;
    if (waiting !== this.#view.waiting) this.#set({ waiting });
  }

  /** Keeps one event feed open on the live connection while notifications are on, and none otherwise. */
  #follow(): void {
    const state: ConnectionState = this.#options.connection.state;
    const connection = this.#view.on && state.phase === "open" ? state.connection : null;
    if (connection === this.#connection) return;
    const old = this.#feed;
    this.#feed = undefined;
    this.#connection = connection;
    this.#stopRetrying();
    old?.close();
    this.#count();
    this.#opening = connection === null ? undefined : this.#attach(connection);
  }

  async #attach(connection: HcConnection): Promise<void> {
    let feed: EventFeed;
    try {
      feed = await connection.subscribe();
    } catch (error) {
      if (this.#connection === connection) this.#retry(connection, message(error));
      return;
    }
    if (this.#connection !== connection) return feed.close();
    this.#feed = feed;
    this.#stopRetrying();
    this.#trigger.baseline(feed.snapshot.terminals);
    this.#count();
    feed.onSnapshot((snapshot) => {
      this.#trigger.baseline(snapshot.terminals);
      this.#count();
    });
    feed.onEvent((event) => this.#heard(event));
    // A feed that ended while the connection stays (a missed heartbeat) is opened again.
    feed.onClose(() => {
      if (this.#feed !== feed) return;
      this.#feed = undefined;
      this.#connection = null;
      this.#count();
      if (!connection.closed) this.#follow();
    });
  }

  #retry(connection: HcConnection, reason: string): void {
    const inMs = retryDelay(this.#attempts);
    this.#attempts += 1;
    this.#set({ retry: { reason, inMs } });
    this.#pendingRetry = (this.#options.schedule ?? timers)(() => {
      this.#pendingRetry = null;
      if (this.#connection === connection) void this.#attach(connection);
    }, inMs);
  }

  #stopRetrying(): void {
    this.#pendingRetry?.();
    this.#pendingRetry = null;
    this.#attempts = 0;
    if (this.#view.retry !== null) this.#set({ retry: null });
  }

  #save(change: Partial<SavedNotices> & Partial<PushView>): void {
    this.#set(change);
    const { on, prefs } = this.#view;
    this.#options.storage.setItem(DESKTOP_NOTICES_KEY, JSON.stringify({ on, prefs }));
    this.#follow();
  }

  async #run(busy: NoticeStep, what: string, step: () => Promise<void>): Promise<void> {
    this.#set({ busy, error: null });
    try {
      await step();
      this.#set({ busy: null });
    } catch (error) {
      this.#set({ busy: null, error: `Could not ${what}. ${message(error)}` });
    }
  }

  #set(change: Partial<PushView>): void {
    this.#view = { ...this.#view, ...change };
    for (const listener of this.#listeners) listener();
  }
}

const bridge = noticeBridge();

/** The desktop app's notifications; null in a browser, where web push does this. */
export const desktopNotices: DesktopNotices | null =
  bridge === null
    ? null
    : new DesktopNotices({
        bridge,
        storage: guardedLocalStorage(),
        connection: connectionStore,
        hostName: () => connectionStore.settings.hostName,
      });
