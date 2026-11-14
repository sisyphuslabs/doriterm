import { HC_VERSION_FLOOR, meetsHcFloor, type MachineView } from "@doriface/protocol";
import { offlineReason } from "./machine-state.ts";

/** What to tell a person about an added machine that needs them: what happened, then why and what to do. */
export interface MachineCause {
  readonly title: string;
  readonly detail: string;
  /** A dial now cannot help (its core must be updated there first), so no Retry is offered beside it. */
  readonly retryless?: true;
}

const KEEPS_TRYING = "Doriterm keeps trying to reach it.";

/**
 * A refusal by its close code, whichever dialer printed it: `doriface-host connect` (apps/host/src/connect/dial.ts) and
 * a mesh line (apps/host/src/mesh/line-grants.ts) refuse the same failure with the same code, so it reads the same.
 */
const BY_CODE: Readonly<Record<number, (name: string) => string>> = {
  4400: (name) => `${name}'s identity changed since it was paired. Pair them again before you trust it.`,
  4401: (name) => `${name} no longer knows this machine. Pair them again with doriface-host connect.`,
  4403: (name) => `${name}'s identity changed since it was paired. Pair them again before you trust it.`,
  4404: (name) => `doriface-host isn't running on ${name}, or it lost its connection. Start it there. ${KEEPS_TRYING}`,
  4408: (name) => `${name} didn't answer in time. It may be asleep or on a slow network. ${KEEPS_TRYING}`,
  4429: () => "There were too many attempts in a short time. Wait a minute, then try again.",
};

/**
 * The code in hc's `why`: `(4404)` from doriface-host connect, `(4404 ×2)` from a mesh member the host holds back, and
 * `closed with 4404` from a mesh line's relay socket.
 */
const CODE = /\((4\d{3})\b|closed with (4\d{3})\b/;

/** A mesh line's refusals whose words carry no code (apps/host/src/mesh/line-grants.ts, connect/mesh-bridge.ts). */
const LINE_CAUSES: readonly { readonly match: RegExp; readonly detail: (name: string) => string }[] = [
  {
    match: /not a member of this mesh|revoked from the mesh/,
    detail: (name) => `${name} is no longer in this mesh. Add it to the mesh again to use it here.`,
  },
  {
    match: /the mesh settles/,
    detail: (name) =>
      `This machine just reconnected and waits a few seconds before it reaches ${name}. ${KEEPS_TRYING}`,
  },
  {
    match: /waiting for the dial budget/,
    detail: (name) => `This machine is spacing out its attempts to reach ${name}. ${KEEPS_TRYING}`,
  },
  {
    match: /keeps no relay uplink/,
    detail: (name) => `This machine has no relay connection, so it can't reach ${name}. Check its doriface-host.`,
  },
  {
    match: /doriface-host is not running/,
    detail: (name) => `doriface-host isn't running on this machine, so it can't reach ${name}. Start it here.`,
  },
];

function knownCause(name: string, why: string): string | undefined {
  const line = LINE_CAUSES.find((cause) => cause.match.test(why));
  if (line !== undefined) return line.detail(name);
  const code = CODE.exec(why);
  const value = code === null ? undefined : Number(code[1] ?? code[2]);
  return value === undefined ? undefined : BY_CODE[value]?.(name);
}

/**
 * An added machine whose herdr-core is below the floor the connected core is held to (#2285): its terminals would fail at
 * their first call. The words are the connected host's (`hostFailure`, connection/host-failure.ts) with the machine
 * named, so either side reads the same. A version hc has not reported, or one with no number, is not judged.
 */
function coreTooOld(name: string, version: string | undefined): MachineCause | undefined {
  const bare = version?.replace(/^hc /, "");
  if (bare === undefined || !/^\d+\.\d+/.test(bare) || meetsHcFloor(bare)) return undefined;
  return {
    title: `${name} needs an hc update`,
    detail: `${name}'s herdr-core is ${bare}, and Doriterm needs ${HC_VERSION_FLOOR} or newer. Run hc update on that computer.`,
    retryless: true,
  };
}

/**
 * Plain words for a machine's state and hc's `why`; undefined while it is connected, unless its core is too old to use.
 * The version is hc's "when last seen", so it is judged only while the line is up: on a machine that is not connected it
 * may be stale, and the line's own cause (a login, a pairing, a host not running) is the one the person can act on.
 */
export function machineCause(
  view: Pick<MachineView, "name" | "state" | "why"> & { readonly version?: string | undefined },
): MachineCause | undefined {
  const { name, state } = view;
  if (state === "connected") return coreTooOld(name, view.version);
  if (state === "reconnecting") {
    return { title: `Reconnecting to ${name}`, detail: `${name} is reconnecting; try again once it is back.` };
  }
  if (state === "connecting") return { title: `Connecting to ${name}`, detail: `${name} is being reached now.` };
  if (state === "needs_login") {
    const detail = `It turned down this machine's login. Run hc machine login ${name} here, then try again.`;
    return { title: `${name} needs a login`, detail };
  }
  const fallback = `${name} isn't answering. Check that it's on and reachable from here. ${KEEPS_TRYING}`;
  return { title: offlineReason(name), detail: knownCause(name, view.why ?? "") ?? fallback };
}
