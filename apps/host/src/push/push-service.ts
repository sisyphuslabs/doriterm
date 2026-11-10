import {
  answerApproval,
  binaryReply,
  type ApprovalCore,
  type ApprovalMark,
  type HcEvent,
  type HeldSubscription,
  MAX_NOTICE_LABEL,
  MAX_NOTICE_OPTIONS,
  type NoticeContext,
  noticeContextOf,
  noticeMachineId,
  type NoticeKind,
  type NoticePrompt,
  type PromptReply,
  type PromptAnswer,
  type PushHostLine,
  type PushNotice,
  type PushPrefs,
  type PushSubscriptionKeys,
  readApproval,
  type Terminal,
} from "@doriface/protocol";
import { hostname } from "node:os";
import { deliverPush, type PushFetch, pushEndpointAllowed } from "./deliver.ts";
import { type NoticeEntry, NoticeBook } from "./notices.ts";
import { LOOPBACK_OWNER, type StoredSubscription, type SubscriptionStore } from "./subscriptions.ts";
import { NoticeTrigger, type Trigger } from "./trigger.ts";
import type { VapidKey } from "./web-push.ts";

/** The host's own hc line, as the push service reads and answers terminals through it (the calls #192's banner uses). */
export type PushCore = ApprovalCore;

export interface PushServiceOptions {
  readonly hostId: string;
  /** This machine as people name it, for a notice about one of its own terminals; the system's host name by default. */
  readonly machineName?: string | undefined;
  readonly vapid: VapidKey;
  readonly subscriptions: SubscriptionStore;
  /** The paired devices' keys, read when a notice goes out, so a device revoked by another process gets none. */
  readonly paired: () => ReadonlySet<string>;
  /** A name people recognise for a device key, recorded with the answer it sent ("answered on ..."). */
  readonly deviceName?: ((owner: string) => string) | undefined;
  readonly post?: PushFetch | undefined;
  /** For tests: origins of a private push service the host may also post to. */
  readonly extraOrigins?: readonly string[] | undefined;
  /** Runs after a subscription is stored; its reply waits for it, so `ok` means the host watches the agents. */
  readonly onSubscribe?: (() => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly log: (line: string) => void;
}

/** A device's open push stream: what it shows focused, until the stream closes. */
export interface Presence {
  focus(terminal: string | null): void;
  leave(): void;
}

/**
 * Web push notices (#193): turns hc's status events into notices for the subscribed devices, posts each straight to
 * its push service, and answers a permission notice only after the prompt is checked against the live terminal.
 */
export class PushService {
  readonly #options: PushServiceOptions;
  readonly #trigger = new NoticeTrigger();
  readonly #notices = new NoticeBook();
  readonly #focus = new Map<string, Map<symbol, string | null>>();
  #core: PushCore | undefined;

  constructor(options: PushServiceOptions) {
    this.#options = options;
  }

  get vapidKey(): string {
    return this.#options.vapid.publicKey;
  }

  /** The line to this host's core; undefined while it is down, when an answer is stale. */
  attach(core: PushCore | undefined): void {
    this.#core = core;
  }

  baseline(terminals: readonly Terminal[]): void {
    this.#trigger.baseline(terminals);
  }

  async event(event: HcEvent): Promise<void> {
    const hit = this.#trigger.event(event, this.#now());
    if (hit !== undefined) await this.#notify(hit);
  }

  presence(owner: string): Presence {
    const key = Symbol(owner);
    const streams = this.#focus.get(owner) ?? new Map<symbol, string | null>();
    this.#focus.set(owner, streams);
    streams.set(key, null);
    return {
      focus: (terminal) => streams.set(key, terminal),
      leave: () => {
        streams.delete(key);
        if (streams.size === 0 && this.#focus.get(owner) === streams) this.#focus.delete(owner);
      },
    };
  }

  held(owner: string): readonly HeldSubscription[] {
    return this.#options.subscriptions.ofOwner(owner).map(({ endpoint, prefs }) => ({ endpoint, prefs }));
  }

  /** False when the endpoint is no push service this host posts to. */
  async subscribe(owner: string, keys: PushSubscriptionKeys, prefs: PushPrefs): Promise<boolean> {
    if (!pushEndpointAllowed(keys.endpoint, this.#options.extraOrigins)) return false;
    this.#options.subscriptions.put(owner, keys, prefs);
    await this.#options.onSubscribe?.();
    return true;
  }

  setPrefs(owner: string, endpoint: string, prefs: PushPrefs): boolean {
    return this.#options.subscriptions.setPrefs(owner, endpoint, prefs);
  }

  unsubscribe(owner: string, endpoint: string): void {
    this.#options.subscriptions.remove(owner, endpoint);
  }

  /** Sends one `test` notice to the device's own endpoint; false when it holds no such subscription. */
  async test(owner: string, endpoint: string): Promise<boolean> {
    const subscription = this.#options.subscriptions.ofOwner(owner).find((entry) => entry.endpoint === endpoint);
    if (subscription === undefined) return false;
    const id = this.#notices.add({ terminal: null, kind: "test", at: this.#now(), mark: undefined });
    await this.#send(subscription, this.#notice(id, "test"));
    return true;
  }

  resolve(id: string): NoticeEntry | undefined {
    return this.#notices.get(id, this.#now());
  }

  /**
   * A notice's prompt rows for a notification to offer: only a prompt answered by one row's own key (no steps, no boxes,
   * no typed text; a typed row is left out of the rest), as it stood when the notice was made. Anything else opens the
   * card.
   */
  prompt(entry: NoticeEntry | undefined): NoticePrompt | undefined {
    const prompt = entry?.mark?.prompt;
    if (prompt === undefined || prompt.multi || prompt.step !== undefined) return undefined;
    const options = prompt.options
      .filter((option) => !option.typed && option.keys.length > 0)
      .slice(0, MAX_NOTICE_OPTIONS)
      .map((option) => ({ id: option.id, label: option.label.slice(0, MAX_NOTICE_LABEL), declines: option.declines }));
    return options.length === 0 ? undefined : { options };
  }

  /**
   * Answers a permission notice's Allow (the plain "Yes" row) or Deny (the dialog's cancel) through the rule #192's
   * banner uses (`answerApproval`); a prompt with no such row is `stale` and nothing is pressed.
   */
  async answer(id: string, answer: PromptAnswer, owner: string): Promise<PushHostLine> {
    const entry = this.resolve(id);
    const reply =
      entry?.kind === "permission" && entry.mark !== undefined ? binaryReply(entry.mark.prompt, answer) : undefined;
    return this.#press(entry, reply, owner);
  }

  /** Answers one row a notification offered (`prompt`), with that row's own key, through the same rule. */
  async choose(id: string, option: string, owner: string): Promise<PushHostLine> {
    const entry = this.resolve(id);
    const offered = this.prompt(entry)?.options.some((row) => row.id === option) === true;
    return this.#press(entry, offered ? { kind: "option", option } : undefined, owner);
  }

  /**
   * One claim per prompt across every client, then the live screen re-read, and the keys only if the marked prompt is
   * still up. `failed`: it did not go through and nothing was pressed; `unknown`: the key press failed after it was
   * sent, so it may have landed; anything else is `stale` and sends nothing.
   */
  async #press(entry: NoticeEntry | undefined, reply: PromptReply | undefined, owner: string): Promise<PushHostLine> {
    const stale: PushHostLine = { t: "stale", terminal: entry?.terminal ?? null };
    const terminal = entry?.terminal;
    const mark = entry?.mark;
    const core = this.#core;
    if (terminal == null || mark === undefined || reply === undefined || core === undefined) return stale;
    // One id per answer: a device's worker and its page each answer for themselves, never as one client.
    const who = {
      by: this.#options.deviceName?.(owner) ?? "a notification",
      client: `push:${owner}:${crypto.randomUUID()}`,
    };
    try {
      const result = await answerApproval(core, mark, reply, who, this.#now());
      switch (result.kind) {
        case "sent":
          return { t: "answered", terminal };
        case "failed":
          this.#options.log(`push: an answer to ${terminal} did not go through, nothing was pressed: ${result.reason}`);
          return { t: "failed", terminal, reason: result.reason };
        case "unknown":
          this.#options.log(`push: an answer to ${terminal} may have reached the agent: ${result.reason}`);
          return { t: "unknown", terminal };
        case "stale":
        case "lost":
          return stale;
      }
    } catch (error) {
      // The claim itself could not be read or written: nothing was pressed.
      this.#options.log(`push: an answer to ${terminal} did not go through, nothing was pressed: ${String(error)}`);
      return { t: "failed", terminal, reason: String(error) };
    }
  }

  async #notify(hit: Trigger): Promise<void> {
    const machine = noticeMachineId(hit.machine);
    const paired = this.#options.paired();
    const recipients = this.#options.subscriptions
      .list()
      .filter(
        (entry) =>
          (entry.owner === LOOPBACK_OWNER || paired.has(entry.owner)) &&
          entry.prefs.events[hit.kind] &&
          !entry.prefs.muted.includes(machine) &&
          !this.#focused(entry.owner, hit.terminal) &&
          pushEndpointAllowed(entry.endpoint, this.#options.extraOrigins),
      );
    if (recipients.length === 0) return;
    // A permission or a question (an `input` notice) is marked as it stands now, so its answer is checked against it.
    const mark = hit.kind === "permission" || hit.kind === "input" ? await this.#mark(hit.terminal) : undefined;
    const context = await this.#context(hit, mark);
    const id = this.#notices.add({ terminal: hit.terminal, kind: hit.kind, at: this.#now(), mark, context });
    await Promise.all(recipients.map((entry) => this.#send(entry, this.#notice(id, hit.kind))));
  }

  async #mark(terminal: string): Promise<ApprovalMark | undefined> {
    const core = this.#core;
    if (core === undefined) return undefined;
    try {
      return await readApproval(core, terminal);
    } catch (error) {
      this.#options.log(`push: could not read the prompt of ${terminal}: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * What the notice is about, for a device that asks over the push stream (#1908): read when the notice is made, so it
   * names the prompt the notice was for. A terminal the core cannot read is named by its machine alone.
   */
  async #context(hit: Trigger, mark: ApprovalMark | undefined): Promise<NoticeContext> {
    const machine = hit.machine ?? this.#options.machineName ?? hostname().split(".")[0] ?? "";
    const core = this.#core;
    if (core === undefined) return { machine };
    try {
      return noticeContextOf(await core.terminal(hit.terminal), machine, mark?.prompt);
    } catch (error) {
      this.#options.log(`push: could not read ${hit.terminal} to name it in a notice: ${String(error)}`);
      return { machine };
    }
  }

  #focused(owner: string, terminal: string): boolean {
    return [...(this.#focus.get(owner)?.values() ?? [])].includes(terminal);
  }

  #notice(id: string, kind: NoticeKind): PushNotice {
    return { v: 1, n: id, k: kind, h: this.#options.hostId };
  }

  async #send(subscription: StoredSubscription, notice: PushNotice): Promise<void> {
    try {
      const delivery = await deliverPush(subscription, notice, this.#options.vapid, this.#options.post);
      if (delivery === "gone") this.#options.subscriptions.removeEndpoint(subscription.endpoint);
      if (delivery === "failed")
        this.#options.log(`push: the push service refused a notice (${new URL(subscription.endpoint).host})`);
    } catch (error) {
      this.#options.log(`push: could not post a notice (${new URL(subscription.endpoint).host}): ${String(error)}`);
    }
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }
}
