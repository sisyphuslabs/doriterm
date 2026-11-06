/**
 * The pure half of the setup skill (skills/doriterm-setup): paths, the service files and what the host's own output
 * says. Nothing here touches the machine, so every rule is unit-tested; setup.ts runs the commands.
 */
import { join } from "node:path";

export type SetupOs = "linux" | "mac";

export const DEFAULT_LABEL = "com.sisyphuslabs.doriface-host";
export const DEFAULT_UNIT = "doriface-host";
/** #721's install.sh registers the LaunchAgent under this label; a machine must never run both. */
export const INSTALLER_LABEL = "dev.omo.doriface-host";
export const REPO_URL = "https://github.com/sisyphuslabs/doriterm.git";

export function setupOs(platform: NodeJS.Platform): SetupOs {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "mac";
  throw new SetupError(
    "unsupported-os",
    `this skill sets up Linux and macOS; on ${platform}, install the desktop app, which carries the host`,
  );
}

export class SetupError extends Error {
  override readonly name = "SetupError";
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface SetupPaths {
  readonly os: SetupOs;
  readonly home: string;
  /** The checkout the service runs; the host also execs it from `<stateDir>/doriface-host`, so it must stay put. */
  readonly src: string;
  /** Never the desktop app's: its own host uses the default `$XDG_STATE_HOME/doriface-host`. */
  readonly stateDir: string;
  /** The LaunchAgent label on macOS, the unit name (without `.service`) on Linux. */
  readonly label: string;
  readonly serviceFile: string;
  readonly logFile: string;
  readonly bun: string;
  readonly hc: string;
  readonly listen: string | undefined;
  /** The hc session (a separate core) the host serves; the default core when undefined. */
  readonly session: string | undefined;
  readonly shell: string;
}

export interface PathOptions {
  readonly src?: string | undefined;
  readonly stateDir?: string | undefined;
  readonly label?: string | undefined;
  readonly listen?: string | undefined;
  readonly session?: string | undefined;
  readonly logFile?: string | undefined;
}

export function stateRoot(home: string, env: Readonly<Record<string, string | undefined>>): string {
  const xdg = env["XDG_STATE_HOME"];
  return xdg !== undefined && xdg !== "" ? xdg : join(home, ".local", "state");
}

/** The state dir the desktop app's own host uses (the host's default); a service host must not share it. */
export function desktopStateDir(home: string, env: Readonly<Record<string, string | undefined>>): string {
  return join(stateRoot(home, env), "doriface-host");
}

export function setupPaths(
  os: SetupOs,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  tools: { readonly bun: string; readonly hc: string; readonly shell: string },
  options: PathOptions = {},
): SetupPaths {
  const label = options.label ?? (os === "mac" ? DEFAULT_LABEL : DEFAULT_UNIT);
  const configHome =
    env["XDG_CONFIG_HOME"] !== undefined && env["XDG_CONFIG_HOME"] !== ""
      ? env["XDG_CONFIG_HOME"]
      : join(home, ".config");
  const paths: SetupPaths = {
    os,
    home,
    src: options.src ?? join(home, ".local", "share", "doriface-host", "src"),
    stateDir: options.stateDir ?? join(stateRoot(home, env), "doriface-host-mesh"),
    label,
    serviceFile:
      os === "mac"
        ? join(home, "Library", "LaunchAgents", `${label}.plist`)
        : join(configHome, "systemd", "user", `${label}.service`),
    logFile:
      options.logFile ??
      (os === "mac"
        ? join(home, "Library", "Logs", `${label}.log`)
        : join(stateRoot(home, env), "doriterm-setup", `${label}.log`)),
    bun: tools.bun,
    hc: tools.hc,
    listen: options.listen,
    session: options.session,
    shell: tools.shell,
  };
  for (const [name, value] of Object.entries(paths)) {
    if (typeof value === "string" && name !== "os" && name !== "label") checkPath(name, value);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(label))
    throw new SetupError("bad-label", `the label may hold letters, digits, ., _ and - only`);
  return paths;
}

/**
 * Both service formats take these values as written: a unit splits on spaces and expands `%` and `$`, and launchd's
 * plist parser decodes entity references its own way, so a path that would need quoting is refused instead.
 */
function checkPath(name: string, value: string): void {
  if (/[\s"'\\%$&<>`]/.test(value) || /\p{Cc}/u.test(value)) {
    throw new SetupError("bad-path", `${name} ${JSON.stringify(value)} holds a space, quote or special character`);
  }
}

/** The service's PATH, built from the paths alone (bun's and hc's dirs, then fixed ones), never from the caller's PATH. */
export function servicePath(paths: SetupPaths): string {
  const dirs = [dirOf(paths.bun), dirOf(paths.hc), join(paths.home, ".local", "bin")];
  if (paths.os === "mac") dirs.push("/opt/homebrew/bin");
  dirs.push("/usr/local/bin", "/usr/bin", "/bin");
  return [...new Set(dirs)].join(":");
}

function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
}

export function hostArgs(paths: SetupPaths): readonly string[] {
  return [
    paths.bun,
    join(paths.src, "apps", "host", "src", "cli.ts"),
    "--hc",
    paths.hc,
    "--state-dir",
    paths.stateDir,
    ...(paths.listen === undefined ? [] : ["--listen", paths.listen]),
    ...(paths.session === undefined ? [] : ["--session", paths.session]),
  ];
}

export function renderUnit(paths: SetupPaths): string {
  return [
    "[Unit]",
    `Description=doriterm host (doriface-host): relay uplink and mesh member, state ${paths.stateDir}`,
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${paths.src}`,
    `Environment=PATH=${servicePath(paths)}`,
    `Environment=SHELL=${paths.shell}`,
    `ExecStart=${hostArgs(paths).join(" ")}`,
    `StandardOutput=append:${paths.logFile}`,
    `StandardError=append:${paths.logFile}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** No comments and no entity references: launchd's parser reads both differently from every other plist reader. */
const string = (value: string): string => `<string>${value}</string>`;

export function renderPlist(paths: SetupPaths): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${string(paths.label)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...hostArgs(paths).map((arg) => `    ${string(arg)}`),
    "  </array>",
    `  <key>WorkingDirectory</key>${string(paths.src)}`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    `    <key>PATH</key>${string(servicePath(paths))}`,
    `    <key>SHELL</key>${string(paths.shell)}`,
    "  </dict>",
    "  <key>ProcessType</key><string>Interactive</string>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    "  <key>ThrottleInterval</key><integer>10</integer>",
    `  <key>StandardOutPath</key>${string(paths.logFile)}`,
    `  <key>StandardErrorPath</key>${string(paths.logFile)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function renderService(paths: SetupPaths): string {
  return paths.os === "mac" ? renderPlist(paths) : renderUnit(paths);
}

export type ExistingService =
  | {
      readonly kind: "checkout";
      readonly stateDir: string | undefined;
      readonly listen: string | undefined;
      readonly session: string | undefined;
      readonly logFile: string | undefined;
      /** The bun and SHELL it runs with, kept on a re-run so a caller with another bun or shell restarts nothing. */
      readonly bun: string | undefined;
      readonly shell: string | undefined;
    }
  | { readonly kind: "other"; readonly program: string };

/**
 * Reads an existing unit or plist: one that runs `<src>/apps/host/src/cli.ts` is this skill's (or the mesh kit's) and
 * is adopted with its state dir; anything else (#721's compiled binary, a hand-written unit) belongs to another
 * install, which the skill will not overwrite.
 */
export function readExistingService(text: string, src: string, home: string): ExistingService {
  // The mesh kit's unit writes `%h` for the home directory, which systemd expands before the host sees it.
  const args = (text.includes("<plist") ? plistArgs(text) : unitArgs(text)).map((arg) =>
    arg.startsWith("%h/") ? join(home, arg.slice(3)) : arg,
  );
  if (!args.includes(join(src, "apps", "host", "src", "cli.ts"))) {
    return { kind: "other", program: args.join(" ") || "(no program)" };
  }
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const log = text.includes("<plist")
    ? /<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]
    : /^StandardOutput=append:(\S+)$/m.exec(text)?.[1];
  return {
    kind: "checkout",
    stateDir: flag("--state-dir"),
    listen: flag("--listen"),
    session: flag("--session"),
    logFile: log,
    bun: args[0],
    shell: text.includes("<plist")
      ? /<key>SHELL<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1]
      : /^Environment=SHELL=(\S+)$/m.exec(text)?.[1],
  };
}

function unitArgs(text: string): string[] {
  const line = text.split("\n").find((entry) => entry.startsWith("ExecStart="));
  if (line === undefined) return [];
  return line
    .slice("ExecStart=".length)
    .split(/\s+/)
    .filter((arg) => arg !== "")
    .map((arg) => arg.replace(/^"(.*)"$/, "$1"));
}

function plistArgs(text: string): string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
  return [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => match[1] ?? "");
}

export type RelayState = "connected" | "connecting" | "reconnecting" | "stopped";

/** The host's latest `relay:` line (apps/host/src/relay/host-uplink.ts) in a stretch of its log. */
export function lastRelayState(log: string): RelayState | undefined {
  let state: RelayState | undefined;
  for (const line of log.split("\n")) {
    if (line.includes("relay: connected to ")) state = "connected";
    else if (line.includes("relay: connecting to ")) state = "connecting";
    else if (line.includes("relay: uplink closed")) state = "reconnecting";
    else if (line.includes("relay: uplink stopped")) state = "stopped";
  }
  return state;
}

export function hcVersionOf(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)?.[1];
}

const versionParts = (value: string): number[] =>
  value
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);

/** `doriface-host --install-hc` prints `herdr-core <version> <installed|updated|...> at <path>`. */
export function installedHcPath(output: string): string {
  const path = /^herdr-core \S+ \S+ at (\S+)$/m.exec(output)?.[1];
  if (path === undefined)
    throw new SetupError("hc", "doriface-host --install-hc did not say where it installed herdr-core");
  return path;
}

/**
 * The cause in a failed host command's output: the host prints `doriface-host: <cause>` and then its usage text
 * (apps/host/src/cli.ts), so the cause is the first such line, not the last line.
 */
export function hostFailure(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.find((line) => line.startsWith("doriface-host")) ?? lines.at(-1) ?? "(no output)";
}

/**
 * Why a failed command failed: the host's own cause line wherever it is, else the last line of stderr, where git and
 * bun put their errors (stdout carries only their banner), and stdout only when stderr is empty.
 */
export function failureOf(stderr: string, stdout: string): string {
  const cause = hostFailure(`${stderr}\n${stdout}`);
  if (cause.startsWith("doriface-host")) return cause;
  return hostFailure(stderr.trim() !== "" ? stderr : stdout);
}

export function bunMeetsFloor(version: string, floor = "1.4.4"): boolean {
  const [a, b] = [versionParts(version), versionParts(floor)];
  for (let i = 0; i < 3; i += 1) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    if (x !== y) return x > y;
  }
  return true;
}

/** The join argument and the public facts `mesh pair` printed; the code and link never leave the invite file. */
export interface MeshInvite {
  readonly link: string;
  readonly fingerprint: string | undefined;
  readonly expires: string | undefined;
}

export function readMeshPair(output: string): MeshInvite {
  const lines = output.split("\n").map((line) => line.trim());
  const link = lines.find((line) => /^(doriface:\/\/|https?:\/\/)\S*pair#/.test(line));
  if (link === undefined) throw new SetupError("no-invite", "mesh pair printed no join link");
  const field = (name: string): string | undefined =>
    lines
      .find((line) => line.startsWith(`${name} `))
      ?.slice(name.length)
      .trim();
  return { link, fingerprint: field("fingerprint"), expires: field("expires") };
}

export interface MeshMemberLine {
  readonly name: string;
  readonly hostId: string;
  readonly line: string;
}

export interface MeshSummary {
  readonly meshId: string;
  readonly sync: string;
  readonly members: readonly MeshMemberLine[];
}

export function readMeshStatus(json: string): MeshSummary {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null) throw new SetupError("bad-status", "mesh status is not an object");
  const meshId = Reflect.get(value, "meshId");
  const sync = Reflect.get(value, "sync");
  const members = Reflect.get(value, "members");
  if (typeof meshId !== "string" || typeof sync !== "string" || !Array.isArray(members)) {
    throw new SetupError("bad-status", "mesh status lacks meshId, sync or members");
  }
  return {
    meshId,
    sync,
    members: members.map((member: unknown) => {
      const name = typeof member === "object" && member !== null ? Reflect.get(member, "name") : undefined;
      const hostId = typeof member === "object" && member !== null ? Reflect.get(member, "hostId") : undefined;
      const line = typeof member === "object" && member !== null ? Reflect.get(member, "line") : undefined;
      return {
        name: typeof name === "string" ? name : typeof hostId === "string" ? hostId : "?",
        hostId: typeof hostId === "string" ? hostId : "",
        line: typeof line === "string" ? line : "?",
      };
    }),
  };
}

/**
 * Each member's line state as this host's core reports it (`hc machine ls --json`); a member the core does not list
 * keeps the state `mesh status` gave it. A mesh line's target ends with the member's hostId
 * (`<launcher> connect --mesh --state-dir <dir> <hostId>`), which is matched instead of a name: after a name fallback
 * the core's name for a member differs from both its mesh name and the status's local name.
 */
export function withCoreLines(summary: MeshSummary, machinesJson: string | undefined): MeshSummary {
  const states = new Map<string, string>();
  if (machinesJson !== undefined) {
    const value: unknown = JSON.parse(machinesJson);
    const machines = typeof value === "object" && value !== null ? Reflect.get(value, "machines") : undefined;
    for (const machine of Array.isArray(machines) ? machines : []) {
      if (typeof machine !== "object" || machine === null) continue;
      const target: unknown = Reflect.get(machine, "target");
      const state: unknown = Reflect.get(machine, "state");
      const hostId = typeof target === "string" ? /(\S+)\s*$/.exec(target)?.[1]?.replace(/^'|'$/g, "") : undefined;
      if (hostId !== undefined && typeof state === "string") states.set(hostId, state);
    }
  }
  return {
    ...summary,
    members: summary.members.map((member) => {
      const state = member.line === "self" ? undefined : states.get(member.hostId);
      return state === undefined ? member : { ...member, line: state };
    }),
  };
}
