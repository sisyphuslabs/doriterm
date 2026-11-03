import type { ByteLink } from "@doriface/crypto";
import { DialPolicy, type DialLimits, type DueReason } from "./dial-policy.ts";
import { MeshDriver } from "./driver.ts";
import { Gossip, type GossipOptions } from "./gossip.ts";
import type { HcMachines } from "./hc-machines.ts";
import { LineGrants } from "./line-grants.ts";
import { Reconciler } from "./reconciler.ts";
import type { MemberEntry } from "./authorize-index.ts";

export interface MeshRuntimeOptions extends Omit<GossipOptions, "policy"> {
  readonly machines: HcMachines;
  /** The absolute path of this doriface-host and its state dir: the pinned `via` (section 7.2). */
  readonly program: string;
  readonly stateDir: string;
  /** Dials a member's hc stream with this host's Noise key (section 7.2). */
  readonly dialLine: (member: MemberEntry) => Promise<ByteLink>;
  readonly limits?: DialLimits;
}

/**
 * The running host's mesh (section 8): one dial policy whose wake-ups reach both sync and herdr, gossip, the line
 * grants behind `line.sock`, and the reconciler driven by every view change.
 */
export class MeshRuntime {
  readonly policy: DialPolicy;
  readonly gossip: Gossip;
  readonly lines: LineGrants;
  readonly reconciler: Reconciler;
  readonly driver: MeshDriver;
  #stopped = false;

  constructor(options: MeshRuntimeOptions) {
    const { clock, random, log } = options;
    this.policy = new DialPolicy({
      clock,
      random,
      onDue: (member, reason) => this.#due(member, reason),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
    this.gossip = new Gossip({
      ...options,
      policy: this.policy,
      onView: (view, result) => {
        void this.driver.viewChanged(view);
        options.onView?.(view, result);
      },
    });
    this.lines = new LineGrants({ view: () => this.gossip.view, policy: this.policy, dial: options.dialLine });
    this.reconciler = new Reconciler({
      machines: options.machines,
      program: options.program,
      stateDir: options.stateDir,
      selfHostId: options.identity.hostId,
      clock,
      log,
    });
    this.driver = new MeshDriver({
      reconciler: this.reconciler,
      lines: this.lines,
      policy: this.policy,
      view: this.gossip.view,
    });
  }

  start(): Promise<void> {
    this.gossip.start();
    return this.driver.start();
  }

  stop(): void {
    this.#stopped = true;
    this.gossip.stop();
    this.reconciler.stop();
  }

  /** Any authenticated session from a member, an hc line or a sync session, is its presence (section 8.2). */
  presence(signPub: string): void {
    this.policy.presence(signPub);
  }

  #due(member: string, reason: DueReason): void {
    if (this.#stopped) return;
    this.gossip.due(member, reason);
    void this.driver.due(member, reason);
  }
}
