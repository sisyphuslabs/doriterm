import type { NoticeContext } from "@doriface/protocol";

/** IPC channels between the preload and the main process. */
export const Channel = {
  openExternal: "doriface:open-external",
  /** A link a terminal printed, opened in the system browser (http, https, mailto). */
  openLink: "doriface:open-link",
  startLocalHost: "doriface:start-local-host",
  setWindowBackground: "doriface:set-window-background",
  closeWindow: "doriface:close-window",
  /** Renderer to main: whether Keep running in the background is on (#1500). */
  runInBackground: "doriface:run-in-background",
  /** Renderer to main: turn Keep running in the background on or off; kept across launches. */
  setRunInBackground: "doriface:set-run-in-background",
  /** Main to renderer: show an app path in the one window (the app menu, a new-window click). */
  navigate: "doriface:navigate",
  /** Main to renderer: a pairing link is waiting; it carries no data. */
  pairingLinkWaiting: "doriface:pairing-link-waiting",
  /** Renderer to main: hands over the waiting pairing link's fragment once, or null. */
  takePairingLink: "doriface:take-pairing-link",
  /** Main to renderer: run one of the page's actions (a Shell menu item), e.g. `pane.split:right`. */
  runAction: "doriface:run-action",
  /** Renderer to main: the page's current trigger for each Shell menu action, so the menu shows the live shortcuts. */
  setMenuKeys: "doriface:set-menu-keys",
  /** Renderer to main: pick herdr-core's hc in a file dialog and keep it for every later start. */
  chooseHc: "doriface:choose-hc",
  /** Main to renderer: an update is downloaded and staged; it carries no data. */
  updateReady: "doriface:update-ready",
  /** Renderer to main: the staged update, or null. */
  takeUpdate: "doriface:take-update",
  /** Renderer to main: quit and install the staged update (Restart to update). */
  installUpdate: "doriface:install-update",
  /** Renderer to main: download, verify and install herdr-core for this user (Install herdr-core). */
  installHc: "doriface:install-hc",
  /** Main to renderer: the phase an Install herdr-core has reached, e.g. `download`. */
  hcInstallPhase: "doriface:hc-install-phase",
  /** Renderer to main: whether this system can show native notifications. */
  noticesSupported: "doriface:notices-supported",
  /** Renderer to main: the OS's standing answer about this app's notifications (`authorized`, `denied`, ...). */
  noticePermission: "doriface:notice-permission",
  /** Renderer to main: show one native notification about an agent (a kind and its terminal, never any text). */
  showNotice: "doriface:show-notice",
  /** Main to renderer: a notification was clicked; carries its terminal address, or null for a test. */
  noticeClicked: "doriface:notice-clicked",
  /** Renderer to main: this computer's pairing offer (`open` for a fresh one, `state` for what stands). */
  pairOffer: "doriface:pair-offer",
  /** Renderer to main: this computer's paired devices and this device's id. */
  pairedDevices: "doriface:paired-devices",
  /** Renderer to main: revoke one paired device by its short id. */
  revokeDevice: "doriface:revoke-device",
  /** Renderer to main: the Direct address the page saved, checked by the shell before it forwards anything (chosen). */
  setDirectTarget: "doriface:set-direct-target",
  /** Renderer to main: one capability to forward bytes to the saved Direct address, or why not (#449). */
  directForward: "doriface:direct-forward",
  /** Renderer to main: the page gave up on a capability, so its late upgrade is refused. */
  cancelDirectForward: "doriface:cancel-direct-forward",
  /** Renderer to main: whether this Mac recognizes a language on the device (#726). */
  dictationAvailable: "doriface:dictation-available",
  /** Renderer to main: start one dictation session in the system recognizer, after the system's own prompts. */
  dictationStart: "doriface:dictation-start",
  /** Renderer to main: end the session's audio; its last words still arrive. */
  dictationStop: "doriface:dictation-stop",
  /** Renderer to main: end the session now. */
  dictationAbort: "doriface:dictation-abort",
  /** Main to renderer: one event of the session this page started. */
  dictationEvent: "doriface:dictation-event",
} as const;

/** The main process hands the app version to the sandboxed preload through this argv entry. */
export const VERSION_ARG = "--doriface-app-version=";

/** Present only when this build's system recognizer loaded (macOS), so the preload offers dictation (#726). */
export const DICTATION_ARG = "--doriface-dictation";

/** Why a dictation did not start: a system setting, no on-device model, another session or prompt, or anything else. */
export const DICTATION_REFUSALS = [
  "mic-system",
  "speech-system",
  "device-mac",
  "mic-windows",
  "device-windows",
  "busy",
  "service",
] as const;
export type DictationRefusal = (typeof DICTATION_REFUSALS)[number];

export type DictationStartAnswer = { readonly session: number } | { readonly refused: DictationRefusal };

/** One event of a dictation session, as the system recognizer reports it. Never carries audio. */
export type DictationEvent =
  | { readonly session: number; readonly kind: "speechstart" | "speechend" | "end" }
  | { readonly session: number; readonly kind: "result"; readonly text: string; readonly final: boolean }
  | { readonly session: number; readonly kind: "error"; readonly code: string };

/** A BCP 47 tag of the shape the recognizer takes (`en-US`, `ko-KR`, `zh-Hant-TW`); nothing else reaches native code. */
export const isDictationLanguage = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(value);

export const isDictationSession = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const MAX_DICTATION_TEXT = 10_000;

export function isDictationEvent(value: unknown): value is DictationEvent {
  if (typeof value !== "object" || value === null) return false;
  const kind: unknown = Reflect.get(value, "kind");
  if (!isDictationSession(Reflect.get(value, "session"))) return false;
  if (kind === "speechstart" || kind === "speechend" || kind === "end") return true;
  if (kind === "result") {
    const text: unknown = Reflect.get(value, "text");
    return (
      typeof text === "string" && text.length <= MAX_DICTATION_TEXT && typeof Reflect.get(value, "final") === "boolean"
    );
  }
  if (kind === "error") {
    const code: unknown = Reflect.get(value, "code");
    return typeof code === "string" && /^[a-z-]{1,32}$/.test(code);
  }
  return false;
}

export function isDictationStartAnswer(value: unknown): value is DictationStartAnswer {
  if (typeof value !== "object" || value === null) return false;
  if (isDictationSession(Reflect.get(value, "session"))) return true;
  const refused: unknown = Reflect.get(value, "refused");
  return DICTATION_REFUSALS.some((known) => known === refused);
}

export type DesktopPlatform = "darwin" | "linux" | "win32";

/** What a native notification says happened, as the web app's notices name it; `test` comes from Send test. */
export const NOTICE_KINDS = ["input", "permission", "done", "error", "test"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/**
 * One native notification. The main process writes its text: what happened by `kind`, and what it is about only from
 * `context`'s named fields, each cleaned of control characters and bounded (#1908), so the page cannot draw a
 * notification of its own.
 */
export interface DesktopNotice {
  readonly kind: NoticeKind;
  /** The terminal it is about (`t7`, `machine/t7`), opened when it is clicked; null for a test. */
  readonly terminal: string | null;
  /** Which agent, machine, space and terminal, and what it asks, as the page read them off its connection. */
  readonly context?: NoticeContext;
}

const MAX_TERMINAL = 160;

/**
 * The OS's standing answer about this app's notifications, as macOS names it: `not-determined` until the first notice
 * makes it ask, then `authorized` or `denied`; `unknown` where the running shell cannot read one (#769).
 */
export const NOTICE_AUTHORIZATIONS = ["authorized", "denied", "not-determined", "unknown"] as const;
export type NoticeAuthorization = (typeof NOTICE_AUTHORIZATIONS)[number];

export const isNoticeAuthorization = (value: unknown): value is NoticeAuthorization =>
  NOTICE_AUTHORIZATIONS.some((known) => known === value);

/** What showing a notification came to: the OS took it, or why it did not (`show()` threw, or its `failed` event). */
export type NoticeAnswer = { readonly accepted: true } | { readonly accepted: false; readonly reason: string };

export function isNoticeAnswer(value: unknown): value is NoticeAnswer {
  if (typeof value !== "object" || value === null) return false;
  const accepted: unknown = Reflect.get(value, "accepted");
  return accepted === true || (accepted === false && typeof Reflect.get(value, "reason") === "string");
}

export function isDesktopNotice(value: unknown): value is DesktopNotice {
  if (typeof value !== "object" || value === null) return false;
  const kind: unknown = Reflect.get(value, "kind");
  const terminal: unknown = Reflect.get(value, "terminal");
  return (
    NOTICE_KINDS.some((known) => known === kind) &&
    (terminal === null || (typeof terminal === "string" && terminal !== "" && terminal.length <= MAX_TERMINAL))
  );
}

export interface LocalHostEndpoint {
  /** The loopback gateway, e.g. `ws://127.0.0.1:52011/v1/hc`. */
  readonly url: string;
  /** Offered as the `doriface.token.<token>` WebSocket subprotocol after `doriface.v1`. */
  readonly token: string;
}

/** One pairing offer for this computer, as the app shows it: what `doriface-host pair` prints, minus the QR drawing. */
export interface PairOffer {
  readonly code: string;
  readonly link: string;
  /** What opens `link`: a web page, or the doriface desktop app (`doriface://pair#…`, the default). */
  readonly opens: "web" | "desktop";
  /** What the QR code encodes for a phone, `<web origin>/pair#…`; absent from a host older than #700. */
  readonly phoneLink?: string;
  readonly hostId: string;
  readonly fingerprint: string;
  /** When the offer stops working, in ms since the epoch. */
  readonly expiresAt: number;
  /** Whether the relay holds the typed code's slot; the link and QR work either way. */
  readonly slot: "pending" | "registered" | "unavailable";
  /** False once the code was used up or has no relay slot. */
  readonly codeUsable: boolean;
}

export interface PairedDevice {
  readonly name: string;
  readonly id: string;
  readonly pairedAt: string;
}

/** What `pairOffer` answers: the offer to show, the device that used it, or why this app cannot ask its host
 * (`unavailable`, which is never a transient offer state).
 */
export type PairOfferAnswer =
  | { readonly state: "pending"; readonly offer: PairOffer }
  | { readonly state: "paired"; readonly device: PairedDevice | null }
  | { readonly state: "expired" }
  | { readonly state: "none" }
  | { readonly state: "unavailable"; readonly reason: string };

/**
 * What `pairedDevices` answers: every device this computer has stored, or why this app cannot ask its host.
 */
export type PairedDevicesAnswer =
  | { readonly state: "listed"; readonly devices: readonly PairedDevice[] }
  | { readonly state: "unavailable"; readonly reason: string };

/** What `revokeDevice` answers: the list after the revoke, or why it did not happen. */
export type RevokeDeviceAnswer =
  | { readonly state: "revoked"; readonly device: PairedDevice; readonly devices: readonly PairedDevice[] }
  | { readonly state: "not-found"; readonly devices: readonly PairedDevice[] }
  | { readonly state: "unavailable"; readonly reason: string };

export function isPairedDevice(value: unknown): value is PairedDevice {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "name") === "string" &&
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "pairedAt") === "string"
  );
}

const pairedDevices = (value: unknown): readonly PairedDevice[] | undefined =>
  Array.isArray(value) && value.every(isPairedDevice) ? value : undefined;

export function isPairedDevicesAnswer(value: unknown): value is PairedDevicesAnswer {
  if (typeof value !== "object" || value === null) return false;
  const state: unknown = Reflect.get(value, "state");
  if (state === "unavailable") return typeof Reflect.get(value, "reason") === "string";
  return state === "listed" && pairedDevices(Reflect.get(value, "devices")) !== undefined;
}

export function isRevokeDeviceAnswer(value: unknown): value is RevokeDeviceAnswer {
  if (typeof value !== "object" || value === null) return false;
  const state: unknown = Reflect.get(value, "state");
  // `unavailable` is why the revoke did not happen and carries no list, so it is read before the list is required.
  if (state === "unavailable") return typeof Reflect.get(value, "reason") === "string";
  const list = pairedDevices(Reflect.get(value, "devices"));
  if (list === undefined) return false;
  if (state === "revoked") return isPairedDevice(Reflect.get(value, "device"));
  return state === "not-found";
}

export function isPairOfferAnswer(value: unknown): value is PairOfferAnswer {
  if (typeof value !== "object" || value === null) return false;
  const state: unknown = Reflect.get(value, "state");
  if (state === "pending") {
    const offer: unknown = Reflect.get(value, "offer");
    return (
      typeof offer === "object" &&
      offer !== null &&
      typeof Reflect.get(offer, "code") === "string" &&
      typeof Reflect.get(offer, "link") === "string" &&
      typeof Reflect.get(offer, "fingerprint") === "string" &&
      typeof Reflect.get(offer, "expiresAt") === "number"
    );
  }
  if (state === "unavailable") return typeof Reflect.get(value, "reason") === "string";
  return state === "none" || state === "expired" || state === "paired";
}

/**
 * Why this computer's host did not start. `code` is doriface-host's own startup error code (`hc-binary-missing`,
 * `hc-version-failed`, `port-in-use`, `permission-denied`, `already-running`, `startup-failed`), or the shell's:
 * `host-exited` (it exited without one), `host-timeout`, `host-spawn-failed` (doriface-host itself could not run).
 */
export interface LocalHostFailure {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly address?: string;
  /** For `hc-version-failed`: the version of an hc older than doriface-host supports. */
  readonly version?: string;
  /** For `hc-binary-missing`: the folders searched for hc after PATH, on this platform. */
  readonly searched?: readonly string[];
  /** The host's own output, for a Details disclosure; never its usage text. */
  readonly details: string;
}

/** A release the updater downloaded and staged: Restart to update installs it. */
export interface UpdateReady {
  readonly version: string;
}

/**
 * One forward capability: the page dials `ws://127.0.0.1:<port>/<capability>` and the shell copies the bytes to the
 * configured Direct address. The target is frozen when the capability is issued, and it is used once (#449).
 */
export interface DirectForward {
  readonly url: string;
}

/** Why the shell will not forward: no usable direct address, or too many forwards already. */
export interface DirectForwardRefused {
  readonly refused: string;
}

export type DirectForwardAnswer = DirectForward | DirectForwardRefused;

export const isDirectForwardRefused = (value: unknown): value is DirectForwardRefused =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "refused") === "string";

export const isDirectForward = (value: unknown): value is DirectForward =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "url") === "string";

export const isUpdateReady = (value: unknown): value is UpdateReady =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "version") === "string";

/** What Install herdr-core answers: the installed version and binary, or why it failed (as a value, like a start). */
export type HcInstallAnswer =
  | { readonly installed: { readonly version: string; readonly path: string } }
  | { readonly failed: { readonly phase: string; readonly message: string } };

const strings = (part: unknown, keys: readonly string[]): boolean =>
  typeof part === "object" && part !== null && keys.every((key) => typeof Reflect.get(part, key) === "string");

export function isHcInstallAnswer(value: unknown): value is HcInstallAnswer {
  if (typeof value !== "object" || value === null) return false;
  const installed: unknown = Reflect.get(value, "installed");
  const failed: unknown = Reflect.get(value, "failed");
  return strings(installed, ["version", "path"]) || strings(failed, ["phase", "message"]);
}

/** A failed start crosses IPC as a value: Electron hands the renderer only the message of a thrown error. */
export interface LocalHostStartFailed {
  readonly failure: LocalHostFailure;
}

/** What the desktop shell exposes to the renderer as `window.doriface`. */
export interface DorifaceBridge {
  readonly version: string;
  readonly platform: DesktopPlatform;
  /** Opens an allowlisted https link in the system browser; resolves false when the link is refused. */
  openExternal(url: string): Promise<boolean>;
  /** Opens a link a terminal printed in the system browser; resolves false when its scheme may not open. */
  openLink(url: string): Promise<boolean>;
  /** Starts (or reuses) doriface-host + hc on this machine; resolves with why it did not start otherwise. */
  startLocalHost(): Promise<LocalHostEndpoint | LocalHostStartFailed>;
  /**
   * This computer's pairing offer: `open` replaces a pending one, `state` reads what stands. Never throws; a host that
   * cannot answer is an `unavailable` answer.
   */
  pairOffer(request: "open" | "state"): Promise<PairOfferAnswer>;
  /** This computer's paired devices; revoking one from here closes its sessions on the host. */
  pairedDevices(): Promise<PairedDevicesAnswer>;
  revokeDevice(id: string): Promise<RevokeDeviceAnswer>;
  /** Calls `listener` with an app path to show, e.g. `/settings` from the app menu. */
  onNavigate(listener: (path: string) => void): void;
  /** Paints the window, now and at the next launch, with the in-app theme's background (`#rrggbb`). */
  setWindowBackground(color: string): Promise<boolean>;
  /** Closes the window as File > Close Window does; the page's own window.close() would skip the close events. */
  closeWindow(): Promise<void>;
  /**
   * Whether closing the window keeps Doriterm and its host running out of sight (no Dock icon or menu bar on a Mac, no
   * window on Windows and Linux), so the phone stays connected; opening the app again brings the window back (#1500).
   */
  runInBackground(): Promise<boolean>;
  /** Turns Keep running in the background on or off for this and every later launch; resolves false when refused. */
  setRunInBackground(enabled: boolean): Promise<boolean>;
  /** Calls `listener` with each pairing link fragment the app is opened with (a doriface: link or an in-app click). */
  onPairingLink(listener: (fragment: string) => void): void;
  /** Calls `listener` with each action id a Shell menu item asks the page to run. */
  onRunAction(listener: (action: string) => void): void;
  /** Tells the menu the page's trigger (Ghostty syntax) for each of its actions. */
  setMenuKeys(keys: Readonly<Record<string, string>>): Promise<boolean>;
  /** Asks for herdr-core's hc in a file dialog and keeps it; resolves with its path, or null when cancelled. */
  chooseHc(): Promise<string | null>;
  /** Downloads, verifies and installs herdr-core for this user, calling `onPhase` as it goes; later starts use it. */
  installHc(onPhase: (phase: string) => void): Promise<HcInstallAnswer>;
  /** Calls `listener` once an update is staged, at once when one already is. */
  onUpdateReady(listener: (update: UpdateReady) => void): void;
  /** Quits and installs the staged update; resolves false when none is staged. */
  installUpdate(): Promise<boolean>;
  /** Whether this system shows native notifications at all (a Linux desktop may run no notification service). */
  noticesSupported(): Promise<boolean>;
  /** The OS's standing answer about this app's notifications; `unknown` where this shell cannot read one. */
  noticePermission(): Promise<NoticeAuthorization>;
  /** Shows a native notification; resolves with whether the OS took it, or why it did not. */
  showNotice(notice: DesktopNotice): Promise<NoticeAnswer>;
  /** Calls `listener` with the terminal of each clicked notification (null for a test one). */
  onNoticeClick(listener: (terminal: string | null) => void): void;
  /** Tells the shell the Direct address the page saved; the shell checks it and forwards nothing else (#449). */
  setDirectTarget(directUrl: string): Promise<boolean>;
  /** Asks for one forward capability, or why the shell will not forward. */
  forwardDirect(): Promise<DirectForwardAnswer>;
  /** Tells the shell the page gave up on a capability, so no socket is opened for it later. */
  cancelDirectForward(url: string): Promise<boolean>;
  /** Dictation through the system recognizer: present only on a Mac build where it loaded (#726). */
  dictationAvailable?(lang: string): Promise<boolean>;
  dictationStart?(lang: string): Promise<DictationStartAnswer>;
  dictationStop?(session: number): Promise<boolean>;
  dictationAbort?(session: number): Promise<boolean>;
  /** Calls `listener` with every event of the sessions this page started. */
  onDictationEvent?(listener: (event: DictationEvent) => void): void;
}

export function parsePlatform(value: string): DesktopPlatform {
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  throw new Error(`unsupported platform ${value}`);
}

const optionalString = (value: object, key: string): boolean => {
  const field: unknown = Reflect.get(value, key);
  return field === undefined || typeof field === "string";
};

export function isLocalHostStartFailed(value: unknown): value is LocalHostStartFailed {
  if (typeof value !== "object" || value === null) return false;
  const failure: unknown = Reflect.get(value, "failure");
  return (
    typeof failure === "object" &&
    failure !== null &&
    typeof Reflect.get(failure, "code") === "string" &&
    typeof Reflect.get(failure, "message") === "string" &&
    typeof Reflect.get(failure, "details") === "string" &&
    optionalString(failure, "path") &&
    optionalString(failure, "address") &&
    optionalString(failure, "version")
  );
}

export function isLocalHostEndpoint(value: unknown): value is LocalHostEndpoint {
  return (
    typeof value === "object" &&
    value !== null &&
    "url" in value &&
    typeof value.url === "string" &&
    "token" in value &&
    typeof value.token === "string"
  );
}
