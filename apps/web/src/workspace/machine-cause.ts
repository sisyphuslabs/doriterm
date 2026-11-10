import type { MachineView } from "@doriface/protocol";

/** What to tell a person about an added machine that is not connected: what happened, then why and what to do. */
export interface MachineCause {
  readonly title: string;
  readonly detail: string;
}

const KEEPS_TRYING = "Doriterm keeps trying to reach it.";

/** hc's `why` repeats the dialer's own words; these are the ones doriface-host prints (apps/host/src/connect/dial.ts). */
const CAUSES: readonly { readonly match: RegExp; readonly detail: (name: string) => string }[] = [
  {
    match: /is not connected to the relay/,
    detail: (name) =>
      `doriface-host isn't running on ${name}, or it lost its connection. Start it there. ${KEEPS_TRYING}`,
  },
  {
    match: /does not know this machine/,
    detail: (name) => `${name} no longer knows this machine. Pair them again with doriface-host connect.`,
  },
  {
    match: /key may not match|refused host/,
    detail: (name) => `${name}'s identity changed since it was paired. Pair them again before you trust it.`,
  },
  {
    match: /did not answer in time/,
    detail: (name) => `${name} didn't answer in time. It may be asleep or on a slow network. ${KEEPS_TRYING}`,
  },
  {
    match: /rate limiting/,
    detail: () => "There were too many attempts in a short time. Wait a minute, then try again.",
  },
];

/** Plain words for a machine's state and hc's `why`; undefined while it is connected. */
export function machineCause(view: Pick<MachineView, "name" | "state" | "why">): MachineCause | undefined {
  const { name, state } = view;
  if (state === "connected") return undefined;
  if (state === "reconnecting") {
    return { title: `Reconnecting to ${name}`, detail: `${name} is reconnecting; try again once it is back.` };
  }
  if (state === "connecting") return { title: `Connecting to ${name}`, detail: `${name} is being reached now.` };
  if (state === "needs_login") {
    const detail = `It turned down this machine's login. Run hc machine login ${name} here, then try again.`;
    return { title: `${name} needs a login`, detail };
  }
  const known = CAUSES.find((cause) => cause.match.test(view.why ?? ""));
  const fallback = `${name} isn't answering. Check that it's on and reachable from here. ${KEEPS_TRYING}`;
  return { title: `${name} is offline`, detail: known?.detail(name) ?? fallback };
}
