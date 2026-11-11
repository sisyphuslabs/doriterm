import { HOST_ID_PATTERN } from "@doriface/relay-client";

/** POSIX single quotes: herdr runs `sh -c "<via> \"$1\""`, so both paths must survive any character. */
export const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * One Windows argument, as `CommandLineToArgvW` reads it: double-quoted, with a trailing run of backslashes doubled
 * so it cannot escape the closing quote. A Windows path holds no `"`, so one in a path is refused, not escaped.
 */
function windowsQuote(text: string): string {
  if (text.includes('"')) throw new TypeError(`a Windows path holds no quote: ${JSON.stringify(text)}`);
  return `"${text.replace(/\\+$/, (run) => run + run)}"`;
}

const isWindows = (platform: NodeJS.Platform): boolean => platform === "win32";

const prefixOf = (program: string, stateDir: string, platform: NodeJS.Platform): string => {
  const quote = isWindows(platform) ? windowsQuote : shellQuote;
  return `${quote(program)} connect --mesh --state-dir ${quote(stateDir)} `;
};

/**
 * The pinned `via` of a mesh line (section 7.2). On POSIX herdr runs it in `sh -c`; the hostId goes there unquoted, so
 * it must be one: `[a-z2-7]` only, which the shell cannot read as anything but a word. On Windows there is no `sh`: the
 * via is the program and its arguments, started directly with the line as one more argument (#1385), so the program
 * must be one Windows can start - the compiled host, never a script.
 */
export function meshVia(program: string, stateDir: string, hostId: string, platform = process.platform): string {
  if (!HOST_ID_PATTERN.test(hostId)) throw new TypeError(`not a hostId: ${JSON.stringify(hostId)}`);
  if (isWindows(platform)) {
    if (!/\.exe$/i.test(program)) {
      throw new TypeError(
        `a Windows mesh line starts a program, not ${JSON.stringify(program)}: run the compiled host`,
      );
    }
    return `${prefixOf(program, stateDir, platform)}${hostId}`;
  }
  // hc owns and kills its sh child when the hello fails. Replace that shell so it owns the bridge itself.
  return `exec ${prefixOf(program, stateDir, platform)}${hostId}`;
}

/**
 * The member a machine's `via` reaches, when it is exactly this host's mesh form: this binary, `--mesh`, this state
 * dir. Any other command, a bare `doriface-host connect` among them, is not a mesh machine.
 */
export function meshHostOf(
  target: string,
  program: string,
  stateDir: string,
  platform = process.platform,
): string | undefined {
  // Previously stored POSIX lines have no exec prefix; they still belong to this host.
  const exec = !isWindows(platform) && target.startsWith("exec ") ? "exec " : "";
  let prefix: string;
  try {
    prefix = `${exec}${prefixOf(program, stateDir, platform)}`;
  } catch {
    return undefined;
  }
  if (!target.startsWith(prefix)) return undefined;
  const hostId = target.slice(prefix.length);
  return HOST_ID_PATTERN.test(hostId) ? hostId : undefined;
}
