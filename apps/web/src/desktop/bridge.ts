/**
 * The desktop shell's `window.doriface`, mirrored from apps/desktop/src/shared/bridge.ts (DorifaceBridge,
 * LocalHostEndpoint, LocalHostFailure). The web app reads it at runtime as an untrusted boundary, so it checks the shape.
 */
export interface LocalHostEndpoint {
  readonly url: string;
  readonly token: string;
}

/** Why this computer's host did not start; `details` is its raw output, shown only on request. */
export interface HostStartFailure {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly address?: string;
  /** For `hc-version-failed`: the version of an hc older than the host supports. */
  readonly version?: string;
  /** For `hc-binary-missing`: the folders the shell searched for hc after PATH, on this platform. */
  readonly searched?: readonly string[];
  readonly details: string;
}

export class HostStartError extends Error {
  override readonly name = "HostStartError";
  readonly failure: HostStartFailure;

  constructor(failure: HostStartFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

const optionalString = (value: object, key: string): string | undefined | null => {
  const field: unknown = Reflect.get(value, key);
  return field === undefined || typeof field === "string" ? field : null;
};

/** The failure in a `{ failure }` answer, or undefined when the answer is not one. */
function failureOf(value: unknown): HostStartFailure | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const failure: unknown = Reflect.get(value, "failure");
  if (typeof failure !== "object" || failure === null) return undefined;
  const code: unknown = Reflect.get(failure, "code");
  const message: unknown = Reflect.get(failure, "message");
  const details: unknown = Reflect.get(failure, "details");
  const path = optionalString(failure, "path");
  const address = optionalString(failure, "address");
  const version = optionalString(failure, "version");
  const searched: unknown = Reflect.get(failure, "searched");
  const folders =
    Array.isArray(searched) && searched.every((dir): dir is string => typeof dir === "string") ? searched : undefined;
  if (typeof code !== "string" || typeof message !== "string" || typeof details !== "string") return undefined;
  if (path === null || address === null || version === null) return undefined;
  return {
    code,
    message,
    details,
    ...(path === undefined ? {} : { path }),
    ...(address === undefined ? {} : { address }),
    ...(version === undefined ? {} : { version }),
    ...(folders === undefined ? {} : { searched: folders }),
  };
}

export interface DesktopBridge {
  startLocalHost(): Promise<LocalHostEndpoint>;
}

/** What one forward capability answers: the URL the page dials, or why the shell will not forward (#449). */
export type ForwardedSocket = { readonly url: string } | { readonly refused: string };

export interface DirectForwardBridge {
  /**
   * One capability: one socket to `directUrl`, which the shell checks itself, for this window, used once. The address
   * travels with the request, so each mesh member's race reaches its own host (#1499).
   */
  forward(directUrl: string): Promise<ForwardedSocket>;
  /** Gives a capability up, so its late upgrade is refused instead of opening a socket. */
  cancel(url: string): Promise<boolean>;
}

/** The shell's byte forwarder, or null outside the desktop app or in a build without it. */
export function directForwardBridge(scope: object = globalThis): DirectForwardBridge | null {
  const forward = bridgeMethod("forwardDirect", scope);
  const cancel = bridgeMethod("cancelDirectForward", scope);
  if (forward === null || cancel === null) return null;
  return {
    forward: async (directUrl) => {
      const answer: unknown = await forward(directUrl);
      const field = (key: string): unknown =>
        typeof answer === "object" && answer !== null ? Reflect.get(answer, key) : undefined;
      const url = field("url");
      if (typeof url === "string") return { url };
      const refused = field("refused");
      return { refused: typeof refused === "string" ? refused : "the shell returned no forward" };
    },
    cancel: async (url) => (await cancel(url)) === true,
  };
}

function isEndpoint(value: unknown): value is LocalHostEndpoint {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "url") === "string" &&
    typeof Reflect.get(value, "token") === "string"
  );
}

/** The desktop shell's method `name`, or null outside the desktop app or in a build without it. */
export function bridgeMethod(name: string, scope: object): ((...args: unknown[]) => unknown) | null {
  const bridge: unknown = Reflect.get(scope, "doriface");
  if (typeof bridge !== "object" || bridge === null) return null;
  const method: unknown = Reflect.get(bridge, name);
  return typeof method === "function" ? (...args) => Reflect.apply(method, bridge, args) : null;
}

const isAppPath = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//");

/** Shows each app path the desktop shell asks for (its app menu, a new-window click) with `show`. */
export function onDesktopNavigate(show: (path: string) => void, scope: object = globalThis): void {
  bridgeMethod(
    "onNavigate",
    scope,
  )?.((path: unknown) => {
    if (isAppPath(path)) show(path);
  });
}

/** Asks the desktop shell to close the window; false outside the desktop app. */
export function closeDesktopWindow(scope: object = globalThis): boolean {
  const close = bridgeMethod("closeWindow", scope);
  if (close === null) return false;
  const closed = close();
  if (closed instanceof Promise) closed.catch((error: unknown) => console.error(`close window: ${String(error)}`));
  return true;
}

/**
 * Opens a link a terminal printed: in the desktop app, in the system browser through the shell (never in the app
 * window); in a browser, in a new tab with no opener. `href` is already one that may open (`openableLink`).
 */
export function openTerminalLink(href: string, scope: object = globalThis): void {
  const open = bridgeMethod("openLink", scope);
  if (open !== null) {
    const opened = open(href);
    if (opened instanceof Promise) opened.catch((error: unknown) => console.error(`open link: ${String(error)}`));
    return;
  }
  const view: unknown = Reflect.get(scope, "open");
  if (typeof view === "function") Reflect.apply(view, scope, [href, "_blank", "noopener,noreferrer"]);
}

/** Keep running in the background (#1500): the desktop shell's saved choice, and keeping a new one. */
export interface BackgroundSetting {
  /** The shell's platform, which decides what the app leaves on screen once its window closes. */
  readonly mac: boolean;
  read(): Promise<boolean>;
  /** Resolves false when the shell did not keep it. */
  set(enabled: boolean): Promise<boolean>;
}

/** The shell's Keep running in the background, or null outside the desktop app or in a build without it. */
export function desktopBackgroundSetting(scope: object = globalThis): BackgroundSetting | null {
  const read = bridgeMethod("runInBackground", scope);
  const set = bridgeMethod("setRunInBackground", scope);
  if (read === null || set === null) return null;
  const bridge: unknown = Reflect.get(scope, "doriface");
  const platform: unknown = typeof bridge === "object" && bridge !== null ? Reflect.get(bridge, "platform") : undefined;
  return {
    mac: platform === "darwin",
    read: async () => (await read()) === true,
    set: async (enabled) => (await set(enabled)) === true,
  };
}

/** Hands the page background to the desktop shell, which paints the window with it now and at the next launch. */
export function setDesktopBackground(color: string, scope: object = globalThis): void {
  const painted = bridgeMethod("setWindowBackground", scope)?.(color);
  if (painted instanceof Promise)
    painted.catch((error: unknown) => console.error(`window background: ${String(error)}`));
}

/** Runs `open` with each pairing link fragment the desktop app hands over; does nothing outside the desktop app. */
export function onDesktopPairingLink(open: (fragment: string) => void, scope: object = globalThis): void {
  bridgeMethod(
    "onPairingLink",
    scope,
  )?.((fragment: unknown) => {
    if (typeof fragment === "string") open(fragment);
  });
}

/** Runs each action a desktop menu item asks for, as its key would; does nothing outside the desktop app. */
export function onDesktopRunAction(run: (action: string) => void, scope: object = globalThis): void {
  bridgeMethod(
    "onRunAction",
    scope,
  )?.((action: unknown) => {
    if (typeof action === "string") run(action);
  });
}

/** Tells the desktop menu the keymap's trigger for each action it lists, so its shortcuts follow the person's keys. */
export function setDesktopMenuKeys(keys: Readonly<Record<string, string>>, scope: object = globalThis): void {
  const shown = bridgeMethod("setMenuKeys", scope)?.(keys);
  if (shown instanceof Promise) shown.catch((error: unknown) => console.error(`menu shortcuts: ${String(error)}`));
}

/** Runs `ready` with the version of each release the desktop app staged; does nothing outside the desktop app. */
export function onDesktopUpdateReady(ready: (version: string) => void, scope: object = globalThis): void {
  bridgeMethod(
    "onUpdateReady",
    scope,
  )?.((update: unknown) => {
    const version = typeof update === "object" && update !== null ? Reflect.get(update, "version") : undefined;
    if (typeof version === "string") ready(version);
  });
}

/** Asks the desktop app to quit and install its staged release (Restart to update). */
export function installDesktopUpdate(scope: object = globalThis): void {
  const installing = bridgeMethod("installUpdate", scope)?.();
  if (installing instanceof Promise)
    installing.catch((error: unknown) => console.error(`install update: ${String(error)}`));
}

export function desktopBridge(scope: object = globalThis): DesktopBridge | null {
  const bridge: unknown = Reflect.get(scope, "doriface");
  if (typeof bridge !== "object" || bridge === null) return null;
  const start: unknown = Reflect.get(bridge, "startLocalHost");
  if (typeof start !== "function") return null;
  return {
    startLocalHost: async () => {
      const answer: unknown = await Reflect.apply(start, bridge, []);
      const failure = failureOf(answer);
      if (failure !== undefined) throw new HostStartError(failure);
      if (!isEndpoint(answer)) throw new Error("the desktop app returned no local host address");
      return answer;
    },
  };
}

/** How Install herdr-core ended: the installed version, or the cause it failed with. */
export type HcInstallOutcome = { readonly version: string } | { readonly error: string };

/**
 * The shell's Install herdr-core (a verified download it installs for this user and keeps as the hc), or null when it
 * offers none: a browser, or a desktop build without it.
 */
export function desktopHcInstaller(
  scope: object = globalThis,
): ((onPhase: (phase: string) => void) => Promise<HcInstallOutcome>) | null {
  const install = bridgeMethod("installHc", scope);
  if (install === null) return null;
  return async (onPhase) => {
    const answer: unknown = await install((phase: unknown) => {
      if (typeof phase === "string") onPhase(phase);
    });
    const installed = typeof answer === "object" && answer !== null ? Reflect.get(answer, "installed") : undefined;
    const failed = typeof answer === "object" && answer !== null ? Reflect.get(answer, "failed") : undefined;
    const version: unknown =
      typeof installed === "object" && installed !== null ? Reflect.get(installed, "version") : undefined;
    const message: unknown = typeof failed === "object" && failed !== null ? Reflect.get(failed, "message") : undefined;
    if (typeof version === "string") return { version };
    return { error: typeof message === "string" ? message : "the desktop app gave no answer" };
  };
}

/** The shell's Choose hc (a file dialog that keeps the chosen herdr-core), or null when it offers none. */
export function desktopHcChooser(scope: object = globalThis): (() => Promise<string | null>) | null {
  const choose = bridgeMethod("chooseHc", scope);
  if (choose === null) return null;
  return async () => {
    const chosen: unknown = await choose();
    return typeof chosen === "string" ? chosen : null;
  };
}
