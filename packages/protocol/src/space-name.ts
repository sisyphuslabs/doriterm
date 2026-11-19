import type { Terminal } from "./__generated__/hc-api.ts";

/**
 * The hc label that names a terminal's space. A loose terminal carrying it is adopted into the space of that name, and a
 * rename writes it on the space's live terminals too, so hc and the layout document agree (#395, #404).
 */
export const SPACE_LABEL = "space";

/** A path's parts on either separator, so a Windows path splits as a POSIX one does. */
export const pathParts = (path: string): readonly string[] => path.split(/[\\/]/).filter((part) => part !== "");

const DRIVE = /^[A-Za-z]:$/;
const LETTER = /^[A-Za-z]$/;
/** Win32's verbatim and device prefixes: `\\?\C:\...`, `\\.\C:\...`, NT's `\??\C:\...`. */
const VERBATIM = /^(?:\\\\[?.]\\|\\\?\?\\)/;

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
  "root",
  "var/root",
  "usr/libexec",
  "opt/homebrew",
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

/**
 * The parts below a Windows volume's root, lower-cased; undefined for a path that is not a Windows one. A volume is a
 * drive (`C:`, after any verbatim prefix) or a share (`\\\\server\\share`, `\\\\?\\UNC\\server\\share`).
 */
function windowsRest(dir: string): readonly string[] | undefined {
  const verbatim = VERBATIM.exec(dir);
  const bare = verbatim === null ? dir : dir.slice(verbatim[0].length);
  const parts = pathParts(bare);
  const below = (depth: number): readonly string[] => parts.slice(depth).map((part) => part.toLowerCase());
  if (DRIVE.test(parts[0] ?? "")) return below(1);
  if (verbatim !== null && parts[0]?.toLowerCase() === "unc") return below(3);
  if (bare.startsWith("\\\\")) return below(2);
  if (bare.includes("\\")) return below(0);
  return undefined;
}

/**
 * A Windows drive as WSL (`/mnt/c`), Cygwin (`/cygdrive/c`) and Git Bash (`/c`) mount it: the first part below the
 * letter, lower-cased. A real POSIX directory can have the same shape (`/w`, a disk at `/mnt/d`), so only Windows' own
 * trees below it count as system ones.
 */
function mountedTop(parts: readonly string[]): string | undefined {
  const [first = "", second = "", third = ""] = parts;
  if ((first === "mnt" || first === "cygdrive") && LETTER.test(second)) return third.toLowerCase();
  return LETTER.test(first) ? second.toLowerCase() : undefined;
}

const MOUNTED_SYSTEM: ReadonlySet<string> = new Set([
  WINDOWS_SYSTEM_TREE,
  "program files",
  "program files (x86)",
  "programdata",
]);

/** Whether a directory is the root or one of the system's own, on Windows (any case) and on POSIX systems. */
export function isSystemDirectory(dir: string): boolean {
  const windows = windowsRest(dir);
  if (windows !== undefined) return windows[0] === WINDOWS_SYSTEM_TREE || WINDOWS_SYSTEM.has(windows.join("/"));
  const parts = pathParts(dir);
  const mounted = mountedTop(parts);
  if (mounted !== undefined && MOUNTED_SYSTEM.has(mounted)) return true;
  return parts[0] === MAC_SYSTEM_TREE || POSIX_SYSTEM.has(parts.join("/"));
}

/** A directory's last segment as a space's name; none for an empty path or a system directory (#2658). */
export function folderSpaceName(dir: string): string | undefined {
  if (dir === "" || isSystemDirectory(dir)) return undefined;
  return pathParts(dir).at(-1);
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
    terminal.labels[SPACE_LABEL] ??
    folderSpaceName(terminal.foreground?.cwd ?? terminal.cwd) ??
    programSpaceName(terminal.argv[0])
  );
}
