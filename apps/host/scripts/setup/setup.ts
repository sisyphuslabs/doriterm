/**
 * The setup skill's steps (skills/doriterm-setup/SKILL.md): each one reads the machine first and changes only what
 * differs, so a re-run on a set-up machine writes nothing and restarts nothing. No step prints a join link, a pairing
 * code or a key.
 */
import { HC_VERSION_FLOOR, meetsHcFloor } from "@doriface/protocol";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  INSTALLER_LABEL,
  REPO_URL,
  SetupError,
  bunMeetsFloor,
  desktopStateDir,
  hcVersionOf,
  failureOf,
  hostFailure,
  installedHcPath,
  lastRelayState,
  readExistingService,
  readMeshPair,
  readMeshStatus,
  withCoreLines,
  renderService,
  setupOs,
  setupPaths,
  type MeshSummary,
  type PathOptions,
  type RelayState,
  type SetupOs,
  type SetupPaths,
} from "./render.ts";

export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string | undefined;
  /** Added to this process's environment. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export type Runner = (command: readonly string[], options?: RunOptions) => Promise<Ran>;

export type StepStatus = "ok" | "changed" | "unchanged" | "warn" | "fail";
export type Report = (step: string, status: StepStatus, detail: string) => void;

export const runCommand: Runner = async (command, options = {}) => {
  const child = Bun.spawn([...command], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
};

export interface SetupContext {
  readonly os: SetupOs;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly run: Runner;
  readonly report: Report;
  readonly options: PathOptions;
}

export function setupContext(report: Report, options: PathOptions, run: Runner = runCommand): SetupContext {
  return { os: setupOs(process.platform), home: homedir(), env: process.env, run, report, options };
}

function srcOf(context: SetupContext): string {
  return context.options.src ?? join(context.home, ".local", "share", "doriface-host", "src");
}

function cliOf(src: string): string {
  return join(src, "apps", "host", "src", "cli.ts");
}

async function must(context: SetupContext, step: string, command: readonly string[], cwd?: string): Promise<Ran> {
  const ran = await context.run(command, { cwd });
  if (ran.code !== 0) {
    const why = failureOf(ran.stderr, ran.stdout);
    throw new SetupError(step, `${command.slice(0, 3).join(" ")} exited ${ran.code}: ${why}`);
  }
  return ran;
}

export function checkBun(context: SetupContext, version: string = Bun.version): void {
  if (!bunMeetsFloor(version)) throw new SetupError("bun", `bun ${version} is older than 1.4.4; run: bun upgrade`);
  context.report("bun", "ok", `bun ${version} at ${process.execPath}`);
}

export interface Checkout {
  readonly sha: string;
  readonly changed: boolean;
}

/** Clones or fast-moves the checkout to `origin/<ref>`; a checkout with local edits is refused, never reset. */
export async function updateCheckout(context: SetupContext, ref: string): Promise<Checkout> {
  const src = srcOf(context);
  let changed = false;
  if (!existsSync(join(src, ".git"))) {
    mkdirSync(dirname(src), { recursive: true });
    await must(context, "checkout", ["git", "clone", "--quiet", REPO_URL, src]);
    changed = true;
  }
  await must(context, "checkout", ["git", "-C", src, "fetch", "--quiet", "origin", ref]);
  const target = (await must(context, "checkout", ["git", "-C", src, "rev-parse", "FETCH_HEAD"])).stdout.trim();
  const head = (await must(context, "checkout", ["git", "-C", src, "rev-parse", "HEAD"])).stdout.trim();
  if (head !== target) {
    const dirty = (await must(context, "checkout", ["git", "-C", src, "status", "--porcelain", "--untracked-files=no"]))
      .stdout;
    if (dirty.trim() !== "") {
      throw new SetupError("checkout", `${src} has local changes; commit or drop them, then run again`);
    }
    await must(context, "checkout", ["git", "-C", src, "checkout", "--quiet", "--detach", target]);
    changed = true;
  }
  if (changed || !existsSync(join(src, "node_modules"))) {
    await must(context, "checkout", [process.execPath, "install", "--frozen-lockfile"], src);
    changed = true;
  }
  context.report("checkout", changed ? "changed" : "unchanged", `${src} at ${target.slice(0, 10)} (origin/${ref})`);
  return { sha: target, changed };
}

/**
 * herdr-core in ~/.local/bin, else on PATH; installed or updated by the host's own checksummed installer when none
 * meets the floor. The installer writes `~/.local/bin/herdr-core` and adds the `hc` link beside it only when no `hc`
 * is on PATH, so the path it reports is the one used, and a qualifying ~/.local/bin binary wins over an older `hc`
 * elsewhere on PATH (otherwise every re-run would install again).
 */
export async function ensureHc(context: SetupContext): Promise<string> {
  const found = await qualifyingHc(context);
  if (found !== undefined) {
    context.report("hc", "unchanged", `herdr-core ${found.version} at ${found.path}`);
    return found.path;
  }
  const installed = installedHcPath(
    (await must(context, "hc", [process.execPath, cliOf(srcOf(context)), "--install-hc"])).stdout,
  );
  const version = hcVersionOf((await must(context, "hc", [installed, "--version"])).stdout);
  if (version === undefined || !meetsHcFloor(version)) {
    throw new SetupError("hc", `${installed} reports ${version ?? "no version"}, below the floor ${HC_VERSION_FLOOR}`);
  }
  context.report("hc", "changed", `installed herdr-core ${version} at ${installed} (floor ${HC_VERSION_FLOOR})`);
  return installed;
}

function hcCandidates(context: SetupContext): string[] {
  const bin = join(context.home, ".local", "bin");
  const onPath = Bun.which("hc");
  return [...new Set([join(bin, "hc"), join(bin, "herdr-core"), ...(onPath === null ? [] : [onPath])])].filter((path) =>
    existsSync(path),
  );
}

/** The first candidate that meets the floor, so install and the later commands pick the same binary (#821). */
async function qualifyingHc(
  context: SetupContext,
): Promise<{ readonly path: string; readonly version: string } | undefined> {
  for (const path of hcCandidates(context)) {
    // oxlint-disable-next-line no-await-in-loop -- the first candidate that meets the floor wins
    const version = hcVersionOf((await context.run([path, "--version"])).stdout);
    if (version !== undefined && meetsHcFloor(version)) return { path, version };
  }
  return undefined;
}

/** For the commands after install, which must not install anything: a foreign or older `hc` first is skipped. */
export async function findHc(context: SetupContext): Promise<string> {
  const found = await qualifyingHc(context);
  if (found === undefined) {
    throw new SetupError("hc", `no herdr-core at or above ${HC_VERSION_FLOOR} is installed; run install first`);
  }
  return found.path;
}

/** `--listen default` and `--session default` go back to the host's own default, whatever the service ran with (#821). */
export const DEFAULT_FLAG = "default";

function chosen(flag: string | undefined, adopted: string | undefined): string | undefined {
  return flag === DEFAULT_FLAG ? undefined : (flag ?? adopted);
}

export function resolvePaths(context: SetupContext, hc: string): SetupPaths {
  const tools = { bun: process.execPath, hc, shell: context.env["SHELL"] ?? userInfo().shell ?? "/bin/sh" };
  const first = setupPaths(context.os, context.home, context.env, tools, {
    ...context.options,
    src: srcOf(context),
    listen: chosen(context.options.listen, undefined),
    session: chosen(context.options.session, undefined),
  });
  if (context.os === "mac") {
    const installer = join(context.home, "Library", "LaunchAgents", `${INSTALLER_LABEL}.plist`);
    if (existsSync(installer)) {
      throw new SetupError(
        "service",
        `${installer} (install.sh) already runs a host here; remove it with install.sh --uninstall before using this skill, or keep it and skip this skill`,
      );
    }
  }
  if (!existsSync(first.serviceFile)) return first;
  const existing = readExistingService(readFileSync(first.serviceFile, "utf8"), first.src, context.home);
  if (existing.kind === "other") {
    throw new SetupError(
      "service",
      `${first.serviceFile} runs another install (${existing.program}); remove it first, or install beside it with its own --label, --state-dir and --listen 127.0.0.1:0`,
    );
  }
  const kept = {
    ...tools,
    bun: existing.bun !== undefined && existsSync(existing.bun) ? existing.bun : tools.bun,
    shell: existing.shell ?? tools.shell,
  };
  return setupPaths(context.os, context.home, context.env, kept, {
    ...context.options,
    src: first.src,
    stateDir: context.options.stateDir ?? existing.stateDir,
    listen: chosen(context.options.listen, existing.listen),
    session: chosen(context.options.session, existing.session),
    logFile: existing.logFile,
  });
}

function writeIfDifferent(file: string, text: string): boolean {
  if (existsSync(file) && readFileSync(file, "utf8") === text) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.new`, text, { mode: 0o644 });
  renameSync(`${file}.new`, file);
  return true;
}

function logSize(file: string): number {
  if (!existsSync(file)) return 0;
  const fd = openSync(file, "r");
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}

function readLog(file: string, from: number): string {
  if (!existsSync(file)) return "";
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(from, size - 256 * 1024);
    const buffer = Buffer.alloc(Math.max(0, size - start));
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

async function macDomain(context: SetupContext): Promise<string> {
  const uid = userInfo().uid;
  return (await context.run(["launchctl", "print", `gui/${uid}`])).code === 0 ? `gui/${uid}` : `user/${uid}`;
}

export interface ServiceResult {
  readonly restarted: boolean;
  /** Where the host's log stood before a restart, so the relay wait reads only the new run's lines. */
  readonly logFrom: number;
}

/** Writes the unit or plist when it differs and (re)starts the service only when something changed or it is down. */
export async function ensureService(
  context: SetupContext,
  paths: SetupPaths,
  checkoutChanged: boolean,
): Promise<ServiceResult> {
  if (paths.stateDir === desktopStateDir(context.home, context.env)) {
    context.report(
      "state",
      "warn",
      `${paths.stateDir} is the desktop app's own state dir; keep the desktop app's "Use this computer" off on this machine`,
    );
  } else {
    context.report("state", "ok", `state dir ${paths.stateDir}`);
  }
  mkdirSync(dirname(paths.logFile), { recursive: true });
  const written = writeIfDifferent(paths.serviceFile, renderService(paths));
  const logFrom = logSize(paths.logFile);
  if (context.os === "linux") {
    if ((await context.run(["systemctl", "--user", "show-environment"])).code !== 0) {
      throw new SetupError(
        "service",
        "no systemd user manager answers (systemctl --user); log in through ssh or a console session and run again",
      );
    }
    const unit = `${paths.label}.service`;
    if (written) await must(context, "service", ["systemctl", "--user", "daemon-reload"]);
    await must(context, "service", ["systemctl", "--user", "enable", "--quiet", unit]);
    const active = (await context.run(["systemctl", "--user", "is-active", "--quiet", unit])).code === 0;
    const restart = written || checkoutChanged || !active;
    if (restart) await must(context, "service", ["systemctl", "--user", "restart", unit]);
    context.report("service", restart ? "changed" : "unchanged", `systemd user unit ${paths.serviceFile}`);
    await ensureLinger(context);
    return { restarted: restart, logFrom };
  }
  const domain = await macDomain(context);
  const target = `${domain}/${paths.label}`;
  const loaded = (await context.run(["launchctl", "print", target])).code === 0;
  let restart = true;
  if (loaded && written) {
    await context.run(["launchctl", "bootout", target]);
    await bootstrap(context, domain, paths.serviceFile);
  } else if (!loaded) {
    await bootstrap(context, domain, paths.serviceFile);
  } else if (checkoutChanged || !(await macRunning(context, target))) {
    await must(context, "service", ["launchctl", "kickstart", "-k", target]);
  } else {
    restart = false;
  }
  context.report("service", restart ? "changed" : "unchanged", `LaunchAgent ${target} (${paths.serviceFile})`);
  return { restarted: restart, logFrom };
}

async function bootstrap(context: SetupContext, domain: string, plist: string): Promise<void> {
  // A bootout returns before launchd has let go of the label, and a bootstrap in that window fails with error 5.
  for (let attempt = 0; ; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each attempt waits for launchd to let go of the label
    const ran = await context.run(["launchctl", "bootstrap", domain, plist]);
    if (ran.code === 0) return;
    if (attempt >= 10)
      throw new SetupError("service", `launchctl bootstrap ${domain} exited ${ran.code}: ${ran.stderr.trim()}`);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await Bun.sleep(500);
  }
}

async function macRunning(context: SetupContext, target: string): Promise<boolean> {
  const ran = await context.run(["launchctl", "print", target]);
  return ran.code === 0 && /^\s*state = running$/m.test(ran.stdout);
}

/**
 * Without linger, systemd stops the user's services at logout and starts them only at the next login. It is turned on
 * with the installer's command, for the user `id -un` names: Bun's `userInfo().username` is the literal "unknown"
 * whenever USER is unset, loginctl knows no such user, and lingering would stay off. `--no-ask-password` stops
 * loginctl from starting a password agent on a terminal; this tool's commands get no terminal to read from, so none
 * starts here with or without it, and the flag keeps that true should that change. Where the system wants an admin
 * for lingering, the tool reports the command for one.
 */
async function ensureLinger(context: SetupContext): Promise<void> {
  const user = (await context.run(["id", "-un"])).stdout.trim();
  const read = async (): Promise<string> =>
    (await context.run(["loginctl", "show-user", user, "-p", "Linger", "--value"])).stdout.trim();
  if ((await read()) === "yes") return context.report("linger", "unchanged", `linger on for ${user}`);
  await context.run(["loginctl", "--no-ask-password", "enable-linger", user]);
  if ((await read()) === "yes") return context.report("linger", "changed", `linger on for ${user}`);
  context.report(
    "linger",
    "warn",
    `linger is off: the host stops at logout; ask an admin to run: sudo loginctl enable-linger ${user}`,
  );
}

/** Waits for the host's own `relay: connected` line, read from its log (on a restart, only the new run's lines). */
export async function waitForRelay(
  context: SetupContext,
  paths: SetupPaths,
  from: number,
  timeoutMs: number,
): Promise<RelayState> {
  const deadline = Date.now() + timeoutMs;
  let state: RelayState | undefined;
  for (;;) {
    state = lastRelayState(readLog(paths.logFile, from));
    if (state === "connected") {
      context.report("relay", "ok", "relay: connected");
      return state;
    }
    if (Date.now() >= deadline) break;
    // oxlint-disable-next-line no-await-in-loop -- each poll reads the log as it is now
    await Bun.sleep(1000);
  }
  throw new SetupError(
    "relay",
    `no relay connection within ${Math.round(timeoutMs / 1000)} s (last: ${state ?? "no relay line"}); see ${paths.logFile}`,
  );
}

/** The log file the service writes, or, for a unit installed without one (the mesh kit's), its journal. */
async function hostLog(context: SetupContext, paths: SetupPaths): Promise<string> {
  if (existsSync(paths.logFile) || context.os === "mac") return readLog(paths.logFile, 0);
  const journal = await context.run(["journalctl", "--user", "-u", `${paths.label}.service`, "-o", "cat", "-n", "500"]);
  return journal.stdout;
}

export interface Verified {
  readonly running: boolean;
  readonly relay: RelayState | undefined;
  readonly mesh: MeshSummary | undefined;
}

export async function verify(context: SetupContext, paths: SetupPaths, minMembers = 0): Promise<Verified> {
  const running =
    context.os === "linux"
      ? (await context.run(["systemctl", "--user", "is-active", "--quiet", `${paths.label}.service`])).code === 0
      : await macRunning(context, `${await macDomain(context)}/${paths.label}`);
  context.report(
    "running",
    running ? "ok" : "fail",
    running ? `${paths.label} is running` : `${paths.label} is not running; see ${paths.logFile}`,
  );
  const relay = lastRelayState(await hostLog(context, paths));
  context.report("relay", relay === "connected" ? "ok" : "fail", `last relay line: ${relay ?? "none"}`);
  const status = await context.run([
    paths.bun,
    cliOf(paths.src),
    "mesh",
    "status",
    "--json",
    "--state-dir",
    paths.stateDir,
  ]);
  let mesh: MeshSummary | undefined;
  if (status.code === 0) {
    const machines = await context.run([paths.hc, "machine", "ls", "--json"], {
      env: paths.session === undefined ? undefined : { HC_SESSION: paths.session },
    });
    // mesh status keeps each line's state from its last roster check; the core's own machine list is current.
    mesh = withCoreLines(readMeshStatus(status.stdout), machines.code === 0 ? machines.stdout : undefined);
    const members = mesh.members.map((member) => `${member.name}=${member.line}`).join(" ");
    const connected = mesh.members.filter((member) => member.line === "self" || member.line === "connected").length;
    const enough = mesh.members.length >= minMembers && (minMembers === 0 || connected === mesh.members.length);
    context.report(
      "mesh",
      enough ? "ok" : "fail",
      `mesh ${mesh.meshId.slice(0, 8)} sync=${mesh.sync} ${mesh.members.length} members: ${members}`,
    );
  } else if (/no mesh/.test(status.stdout + status.stderr)) {
    context.report("mesh", minMembers > 0 ? "fail" : "ok", "this host is in no mesh yet");
  } else {
    context.report("mesh", "fail", `mesh status exited ${status.code}: ${hostFailure(status.stderr)}`);
  }
  const lines = mesh?.members.every((member) => member.line === "self" || member.line === "connected") ?? false;
  if (!running || relay !== "connected" || (minMembers > 0 && ((mesh?.members.length ?? 0) < minMembers || !lines))) {
    throw new SetupError("verify", "the host is not set up yet; the lines above say which part");
  }
  return { running, relay, mesh };
}

/** Opens a single-use mesh offer (10 minutes, admitted without asking) and writes its link to `out` (0600) only. */
export async function invite(context: SetupContext, paths: SetupPaths, out: string): Promise<void> {
  const ran = await must(context, "invite", [
    paths.bun,
    cliOf(paths.src),
    "mesh",
    "pair",
    "--auto",
    "--no-qr",
    "--state-dir",
    paths.stateDir,
  ]);
  const offer = readMeshPair(ran.stdout);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  rmSync(out, { force: true });
  writeFileSync(out, `${offer.link}\n`, { mode: 0o600, flag: "wx" });
  context.report(
    "invite",
    "ok",
    `join link written to ${out} (0600, single use, expires ${offer.expires ?? "in 10 minutes"}); this host's fingerprint ${offer.fingerprint ?? "?"}`,
  );
}

/** Joins the mesh named by the link in `from`, then deletes the spent link. The link never reaches the output. */
export async function joinMesh(context: SetupContext, paths: SetupPaths, from: string): Promise<void> {
  const link = readFileSync(from, "utf8").trim();
  if (link === "") throw new SetupError("join", `${from} is empty`);
  // The host reads the link from the file: on the command line, other local users could read it from /proc (#821).
  const ran = await context.run([
    paths.bun,
    cliOf(paths.src),
    "mesh",
    "join",
    "--from-file",
    from,
    "--yes",
    "--state-dir",
    paths.stateDir,
  ]);
  const said = `${ran.stdout}\n${ran.stderr}`.split(link).join("<link>").trim();
  if (ran.code !== 0) throw new SetupError("join", `mesh join exited ${ran.code}: ${hostFailure(said)}`);
  rmSync(from, { force: true });
  context.report("join", "changed", `${said.split("\n").at(-1) ?? "joined"}; removed the spent link ${from}`);
}

/** Stops and removes the service; the checkout, the state dir (keys, paired devices, mesh) and the log stay. */
export async function uninstall(context: SetupContext, paths: SetupPaths): Promise<void> {
  if (context.os === "linux") {
    await context.run(["systemctl", "--user", "disable", "--now", "--quiet", `${paths.label}.service`]);
    rmSync(paths.serviceFile, { force: true });
    await context.run(["systemctl", "--user", "daemon-reload"]);
  } else {
    const target = `${await macDomain(context)}/${paths.label}`;
    await context.run(["launchctl", "bootout", target]);
    // bootout returns before launchd has stopped the job; wait for the label to go before calling it removed.
    for (let attempt = 0; ; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each check reads launchd as it is now
      if ((await context.run(["launchctl", "print", target])).code !== 0) break;
      if (attempt >= 20) throw new SetupError("uninstall", `${target} is still loaded 10 s after bootout`);
      // oxlint-disable-next-line no-await-in-loop -- as above
      await Bun.sleep(500);
    }
    rmSync(paths.serviceFile, { force: true });
  }
  context.report("uninstall", "changed", `removed ${paths.serviceFile}; ${paths.stateDir} and ${paths.src} stay`);
}
