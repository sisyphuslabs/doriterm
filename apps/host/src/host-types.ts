import release from "../../desktop/package.json" with { type: "json" };
import type { MeshStatus } from "@doriface/protocol";
import type { PlanPolicy } from "@doriface/policy";
import type { CreateSocket } from "@doriface/relay-client";
import type { ListenAddress } from "./listen.ts";
import type { MeshHooks } from "./mesh/host-hooks.ts";
import type { PairingSlotRegistrar } from "./pairing-slots.ts";

/** Set by apps/desktop/scripts/build-host.ts (`bun build --define`) to the version a release builds, prerelease included. */
declare const DORIFACE_BUILD_VERSION: string | undefined;

/**
 * The version this host reports on /healthz, in its start-up line and for --version: the build's, else the version in
 * apps/desktop/package.json, which is the one source of the release version (.github/scripts/release-version.ts).
 */
export const HOST_VERSION: string =
  typeof DORIFACE_BUILD_VERSION === "string" ? DORIFACE_BUILD_VERSION : release.version;

export interface HostOptions {
  readonly listen: ListenAddress;
  readonly token: string;
  readonly hc: string;
  readonly session?: string | undefined;
  /** Environment for the `hc connect` children; defaults to this process's. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Allow a non-loopback bind. The endpoint is plaintext, so this exposes the token and the shell. */
  readonly unsafeListen?: boolean | undefined;
  /** Where the host keys, paired devices and pending pairing live; enables `/v1/e2ee`. */
  readonly stateDir?: string | undefined;
  /** A second listener serving only healthz and `/v1/e2ee`; it may bind any address. */
  readonly lanListen?: ListenAddress | undefined;
  /** For tests: messages per direction between rekeys. */
  readonly rekeyInterval?: number | undefined;
  /** For tests: the direct-path idle close (default 90 s). */
  readonly directIdleMs?: number | undefined;
  /** For tests: how long a detached hc session waits for its client's resume (default RESUME_GRACE_MS, 120 s). */
  readonly resumeGraceMs?: number | undefined;
  /**
   * For tests: how long the hello of an `hc connect` the host's own writers start (the end sweeper, the OS write, the
   * git facts, the mesh status publisher, the mesh offer service, the push core feed and the host's control connection,
   * each through `openOnCore`) may go unanswered before that connection fails (default 10 s). `Infinity` leaves those
   * connects to stop.
   */
  readonly hcHandshakeTimeoutMs?: number | undefined;
  /** Registers typed-code pairing slots; defaults to the relay uplink when there is one. */
  readonly pairingSlots?: PairingSlotRegistrar | undefined;
  /** Keeps an authenticated uplink to this relay and answers E2EE sessions through it; needs `stateDir`. */
  readonly relay?: { readonly url: string; readonly createSocket?: CreateSocket | undefined } | undefined;
  /** The mesh status `mesh status` asks for; undefined while this host is in no mesh. Defaults to mesh.json's. */
  readonly meshStatus?: (() => MeshStatus | undefined) | undefined;
  /** For tests: the program mesh lines' `via` names; defaults to this executable or a launcher of this entry point. */
  readonly meshProgram?: string | undefined;
  /** The running mesh parts the mesh commands and status reach; defaults to this host's own sync (`syncHooks`). */
  readonly meshHooks?: MeshHooks | undefined;
  /** For tests: origins of a private push service the host may post web push notices to, besides the browsers' own. */
  readonly pushTestOrigins?: readonly string[] | undefined;
  /** The plan this host runs under; unset reads `DORIFACE_POLICY` (open when it is unset too). */
  readonly policy?: PlanPolicy | undefined;
  readonly log: (line: string) => void;
  /** The OS this host reports on its core (`process.platform` unless a test names another). */
  readonly platform?: string;
}

export interface E2eeEndpoint {
  readonly hostId: string;
  readonly fingerprint: string;
  /** `/v1/e2ee` on the main listener. */
  readonly url: string;
  /** The dialable `/v1/e2ee` URLs of the LAN listener (IP literals, also sent in message 2); empty without one. */
  readonly lanUrls: readonly string[];
}

export interface Host {
  /** The WebSocket endpoint, e.g. `ws://127.0.0.1:7766/v1/hc`. */
  readonly url: string;
  readonly port: number;
  readonly hcVersion: string;
  readonly e2ee: E2eeEndpoint | undefined;
  /** The relay this host keeps its uplink to, when it does. */
  readonly relayUrl: string | undefined;
  /**
   * Settles once the write of this host's OS on its core is done and its one-shot `hc connect` child has exited; at once
   * if no client has opened a pipe yet, since that write starts with the first pipe.
   */
  hostInfoSettled(): Promise<void>;
  /**
   * Settles once the git-facts tick in flight is over and its `hc connect` child has exited; at once if no client has
   * opened a pipe yet. Its next tick waits on a timer, so no tick's child runs until the caller yields to timers.
   */
  gitFactsSettled(): Promise<void>;
  /**
   * Settles once the mesh-status ticks asked for so far are over and their `hc connect` children have exited; at once if
   * no client has opened a pipe yet. Its next tick waits on a timer, like the git facts'.
   */
  meshStatusSettled(): Promise<void>;
  /** Closes every client and `hc connect` child, then the listener. */
  stop(): Promise<void>;
}
