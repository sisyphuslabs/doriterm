import { HOST_ID_PATTERN } from "@doriface/relay-client";

/** POSIX single quotes: herdr runs `sh -c "<via> \"$1\""`, so both paths must survive any character. */
export const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

const prefixOf = (program: string, stateDir: string): string =>
  `${shellQuote(program)} connect --mesh --state-dir ${shellQuote(stateDir)} `;

/**
 * The pinned `via` of a mesh line (section 7.2). The hostId goes into herdr's `sh -c` unquoted, so it must be one:
 * `[a-z2-7]` only, which the shell cannot read as anything but a word.
 */
export function meshVia(program: string, stateDir: string, hostId: string): string {
  if (!HOST_ID_PATTERN.test(hostId)) throw new TypeError(`not a hostId: ${JSON.stringify(hostId)}`);
  // hc owns and kills its sh child when the hello fails. Replace that shell so it owns the bridge itself.
  return `exec ${prefixOf(program, stateDir)}${hostId}`;
}

/**
 * The member a machine's `via` reaches, when it is exactly this host's mesh form: this binary, `--mesh`, this state
 * dir. Any other command, a bare `doriface-host connect` among them, is not a mesh machine.
 */
export function meshHostOf(target: string, program: string, stateDir: string): string | undefined {
  // Previously stored lines have no exec prefix; they still belong to this host.
  const prefix = `${target.startsWith("exec ") ? "exec " : ""}${prefixOf(program, stateDir)}`;
  if (!target.startsWith(prefix)) return undefined;
  const hostId = target.slice(prefix.length);
  return HOST_ID_PATTERN.test(hostId) ? hostId : undefined;
}
