import type { Terminal } from "./__generated__/hc-api.ts";

/** A path's parts on either separator, so a Windows path splits as a POSIX one does. */
const partsOf = (path: string): readonly string[] => path.split(/[\\/]/).filter((part) => part !== "");

const DRIVE = /^[A-Za-z]:$/;

/**
 * Directories a shell starts in when nobody chose one: the root, and the system's own directories (the ones a service,
 * a login item or a GUI launcher hands its child, such as `C:\Windows\System32` on Windows). A scratch directory such as
 * `/tmp` is not one: people `cd` there on purpose.
 */
const POSIX_SYSTEM: ReadonlySet<string> = new Set([
  "",
  "bin",
  "sbin",
  "usr",
  "usr/bin",
  "usr/sbin",
  "usr/local",
  "usr/local/bin",
  "usr/lib",
  "usr/share",
  "etc",
  "var",
  "lib",
  "lib64",
  "opt",
  "dev",
  "proc",
  "sys",
  "boot",
  "run",
  "home",
  "Users",
  "Volumes",
  "Applications",
  "Library",
  "private",
  "private/var",
  "private/etc",
]);

/** Below these every directory is the system's own: Windows' install directory, macOS's sealed system volume. */
const WINDOWS_SYSTEM_TREE = "windows";
const MAC_SYSTEM_TREE = "System";

const WINDOWS_SYSTEM: ReadonlySet<string> = new Set([
  "",
  "program files",
  "program files (x86)",
  "programdata",
  "users",
]);

/** Whether a directory is the root or one of the system's own, on Windows (any case) and on POSIX systems. */
export function isSystemDirectory(dir: string): boolean {
  const parts = partsOf(dir);
  const drive = parts[0] !== undefined && DRIVE.test(parts[0]);
  if (drive || dir.includes("\\")) {
    const rest = (drive ? parts.slice(1) : parts).map((part) => part.toLowerCase());
    return rest[0] === WINDOWS_SYSTEM_TREE || WINDOWS_SYSTEM.has(rest.join("/"));
  }
  return parts[0] === MAC_SYSTEM_TREE || POSIX_SYSTEM.has(parts.join("/"));
}

/** A directory's last segment as a space's name; none for an empty path or a system directory (#2658). */
export function folderSpaceName(dir: string): string | undefined {
  if (dir === "" || isSystemDirectory(dir)) return undefined;
  return partsOf(dir).at(-1);
}

/** The shells by the name their users call them. */
const SHELL_NAMES: ReadonlyMap<string, string> = new Map([
  ["pwsh", "PowerShell"],
  ["powershell", "PowerShell"],
  ["cmd", "Command Prompt"],
  ["bash", "Bash"],
  ["zsh", "Zsh"],
  ["fish", "Fish"],
  ["nu", "Nushell"],
  ["sh", "Shell"],
]);

/** `/bin/zsh`, a login shell's `-zsh` and `cmd.exe` as the bare program name. */
export const programName = (path: string): string =>
  (path.split(/[/\\]/).at(-1) ?? path).replace(/^-+/, "").replace(/\.exe$/i, "");

/**
 * The program a terminal started (its shell, as a rule) as a space's name: `pwsh.exe` reads "PowerShell". "Space" when
 * no program is known, as for a space whose tabs show no live terminal.
 */
export function programSpaceName(program: string | undefined): string {
  const name = programName(program ?? "");
  return name === "" ? "Space" : (SHELL_NAMES.get(name.toLowerCase()) ?? name);
}

type Placed = Pick<Terminal, "labels" | "cwd" | "foreground" | "argv">;

/**
 * A terminal's space: its `space` label, else the last segment of its directory, else, where that directory is a system
 * one, the program it started (#2658). Never a system path such as `C:\Windows\System32`.
 */
export function terminalSpaceName(terminal: Placed): string {
  return (
    terminal.labels["space"] ??
    folderSpaceName(terminal.foreground?.cwd ?? terminal.cwd) ??
    programSpaceName(terminal.argv[0])
  );
}
