/** hc's states in the sidebar's words; the offline notice and action reasons use the same word. */
const LABELS: Readonly<Record<string, string>> = { needs_login: "needs login", unreachable: "offline" };

export const stateLabel = (state: string): string => LABELS[state] ?? state;

/** The existing offline notice's wording, also used when an action must wait for the machine. */
export const offlineReason = (name = "the machine"): string => `${name} is ${stateLabel("unreachable")}`;
