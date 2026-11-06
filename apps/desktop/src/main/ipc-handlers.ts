import { allowedExternal } from "../config/external.ts";
import { terminalLinkTarget } from "../config/terminal-link.ts";
import { isHexColour } from "../config/window.ts";
import { isSameOrigin } from "../config/origin.ts";
import { HcInstallError, type HcInstalled } from "@doriface/host/hc-install";
import {
  Channel,
  type DesktopNotice,
  type DirectForwardAnswer,
  type HcInstallAnswer,
  isDesktopNotice,
  type LocalHostEndpoint,
  type LocalHostStartFailed,
  type NoticeAnswer,
  type NoticeAuthorization,
  type PairedDevicesAnswer,
  type PairOfferAnswer,
  type RevokeDeviceAnswer,
  type UpdateReady,
} from "../shared/bridge.ts";
import { LocalHostStartError } from "./local-host.ts";
import { SHELL_MENU_ACTIONS } from "./shell-menu.ts";

/** The part of an IPC event the gate reads; `senderFrame` is null once the frame is gone. */
export interface IpcSender {
  readonly senderFrame: { readonly url: string } | null;
  /** The page that sent it: a forward capability is bound to it, so another window cannot use one (#449). */
  readonly sender?: { readonly id: number } | undefined;
}

/** A sender the main process can answer on its own channel as well, as Install herdr-core's progress does. */
export interface IpcReplySender extends IpcSender {
  readonly sender: { readonly id: number; send(channel: string, ...args: unknown[]): void };
}

export interface IpcDeps {
  readonly origin: string;
  readonly startLocalHost: () => Promise<LocalHostEndpoint>;
  /** This computer's pairing offer: `open` replaces a pending one, `state` reads what stands. */
  readonly pairOffer: (request: "open" | "state") => Promise<PairOfferAnswer>;
  /** Every device this computer has stored, and revoking one of them from here. */
  readonly pairedDevices: () => Promise<PairedDevicesAnswer>;
  readonly revokeDevice: (id: string) => Promise<RevokeDeviceAnswer>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly setWindowBackground: (color: string) => void;
  readonly closeWindow: () => void;
  readonly takePairingLink: () => string | undefined;
  readonly setMenuKeys: (keys: ReadonlyMap<string, string>) => void;
  /** Shows the file dialog for hc and keeps the choice; undefined when it was cancelled. */
  readonly chooseHc: () => Promise<string | undefined>;
  readonly takeUpdate: () => UpdateReady | null;
  /** Quits and installs the staged update; false when none is staged. */
  readonly installUpdate: () => boolean;
  /** Installs herdr-core for this user and keeps it as the hc later starts use; throws HcInstallError with why not. */
  readonly installHc: (onPhase: (phase: string) => void) => Promise<HcInstalled>;
  readonly noticesSupported: () => boolean;
  /** The OS's standing answer about this app's notifications; `unknown` where this shell cannot read one. */
  readonly noticePermission: () => NoticeAuthorization;
  /** Shows one notification and answers whether the OS took it. */
  readonly showNotice: (notice: DesktopNotice) => Promise<NoticeAnswer>;
  /** Keeps the page's saved Direct address, checked by the shell; a change drops every forward. */
  readonly setDirectTarget: (directUrl: string) => boolean;
  /** One capability for `windowId`, or why the shell will not forward. */
  readonly forwardDirect: (windowId: number) => Promise<DirectForwardAnswer>;
  /** Forgets a capability the page gave up on. */
  readonly cancelDirectForward: (url: string) => boolean;
}

export interface IpcHandlers {
  openExternal(event: IpcSender, candidate: unknown): Promise<boolean>;
  /** A link a terminal printed: any host, but only http, https and mailto (`terminalLinkTarget`). */
  openLink(event: IpcSender, candidate: unknown): Promise<boolean>;
  startLocalHost(event: IpcSender): Promise<LocalHostEndpoint | LocalHostStartFailed>;
  /**
   * This computer's pairing offer; anything but the two known requests is refused rather than guessed at. `open`
   * replaces a pending offer and `state` reads it.
   */
  pairOffer(event: IpcSender, candidate: unknown): Promise<PairOfferAnswer | null>;
  pairedDevices(event: IpcSender): Promise<PairedDevicesAnswer>;
  /** A short id only: anything else is refused here, so a hand-edited renderer cannot address a path. */
  revokeDevice(event: IpcSender, candidate: unknown): Promise<RevokeDeviceAnswer | null>;
  /** Paints the window and the next launch with the in-app theme's background; only `#rrggbb` is taken. */
  setWindowBackground(event: IpcSender, candidate: unknown): Promise<boolean>;
  /** Closes the window the way its Close Window item does, so the close events (and the saved placement) run. */
  closeWindow(event: IpcSender): Promise<void>;
  takePairingLink(event: IpcSender): string | null;
  /** Shows the page's shortcuts in the Shell menu; only its own action ids and short trigger text are taken. */
  setMenuKeys(event: IpcSender, candidate: unknown): Promise<boolean>;
  /** Choose hc: the chosen file's path, or null when the dialog was cancelled. */
  chooseHc(event: IpcSender): Promise<string | null>;
  /** The staged update, or null. */
  takeUpdate(event: IpcSender): UpdateReady | null;
  /** Restart to update: false when no update is staged. */
  installUpdate(event: IpcSender): Promise<boolean>;
  /** Install herdr-core: each phase is sent to the page as it starts; a failure is answered as a value. */
  installHc(event: IpcReplySender): Promise<HcInstallAnswer>;
  noticesSupported(event: IpcSender): Promise<boolean>;
  /** The OS's standing answer about this app's notifications. */
  noticePermission(event: IpcSender): Promise<NoticeAuthorization>;
  /** Shows a native notification; only a known kind and a terminal address are taken, never text. */
  showNotice(event: IpcSender, candidate: unknown): Promise<NoticeAnswer>;
  /** Keeps the page's saved Direct address as the only forward target, checked by the shell itself (#449). */
  setDirectTarget(event: IpcSender, candidate: unknown): Promise<boolean>;
  /** One forward capability for the window that asked, or why the shell will not forward. */
  forwardDirect(event: IpcSender): Promise<DirectForwardAnswer>;
  /** Forgets a capability this window gave up on. */
  cancelDirectForward(event: IpcSender, candidate: unknown): Promise<boolean>;
}

const TRIGGER = /^[a-z0-9_+=\-[\];',./`\\]{1,40}$/;

/** The entries the menu can show; one it cannot (another action, or trigger text it does not take) is left out alone. */
function menuKeys(candidate: unknown): Map<string, string> | undefined {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return undefined;
  const keys = new Map<string, string>();
  for (const [action, trigger] of Object.entries(candidate)) {
    if (SHELL_MENU_ACTIONS.has(action) && typeof trigger === "string" && TRIGGER.test(trigger))
      keys.set(action, trigger);
  }
  return keys;
}

function assertAppFrame(event: IpcSender, origin: string): void {
  const url = event.senderFrame?.url ?? "";
  if (!isSameOrigin(url, origin)) throw new Error(`refused IPC from ${url === "" ? "a detached frame" : url}`);
}

/** Every handler refuses senders outside the app origin before doing anything. */
export function ipcHandlers(deps: IpcDeps): IpcHandlers {
  return {
    async openExternal(event, candidate) {
      assertAppFrame(event, deps.origin);
      const url = typeof candidate === "string" ? allowedExternal(candidate) : undefined;
      if (url === undefined) return false;
      await deps.openExternal(url);
      return true;
    },
    async openLink(event, candidate) {
      assertAppFrame(event, deps.origin);
      const url = typeof candidate === "string" ? terminalLinkTarget(candidate) : undefined;
      if (url === undefined) return false;
      await deps.openExternal(url);
      return true;
    },
    async startLocalHost(event) {
      assertAppFrame(event, deps.origin);
      try {
        return await deps.startLocalHost();
      } catch (error) {
        if (error instanceof LocalHostStartError) return { failure: error.failure };
        throw error;
      }
    },
    async pairOffer(event, candidate) {
      assertAppFrame(event, deps.origin);
      if (candidate !== "open" && candidate !== "state") return null;
      try {
        return await deps.pairOffer(candidate);
      } catch (error) {
        return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async pairedDevices(event) {
      assertAppFrame(event, deps.origin);
      try {
        return await deps.pairedDevices();
      } catch (error) {
        return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async revokeDevice(event, candidate) {
      assertAppFrame(event, deps.origin);
      if (typeof candidate !== "string" || !/^[0-9A-F]{8}$/i.test(candidate)) return null;
      try {
        return await deps.revokeDevice(candidate.toUpperCase());
      } catch (error) {
        return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async setWindowBackground(event, candidate) {
      assertAppFrame(event, deps.origin);
      if (!isHexColour(candidate)) return false;
      deps.setWindowBackground(candidate);
      return true;
    },
    async closeWindow(event) {
      assertAppFrame(event, deps.origin);
      deps.closeWindow();
    },
    takePairingLink(event) {
      assertAppFrame(event, deps.origin);
      return deps.takePairingLink() ?? null;
    },
    async setMenuKeys(event, candidate) {
      assertAppFrame(event, deps.origin);
      const keys = menuKeys(candidate);
      if (keys === undefined) return false;
      deps.setMenuKeys(keys);
      return true;
    },
    async chooseHc(event) {
      assertAppFrame(event, deps.origin);
      return (await deps.chooseHc()) ?? null;
    },
    takeUpdate(event) {
      assertAppFrame(event, deps.origin);
      return deps.takeUpdate();
    },
    async installUpdate(event) {
      assertAppFrame(event, deps.origin);
      return deps.installUpdate();
    },
    async installHc(event) {
      assertAppFrame(event, deps.origin);
      try {
        const installed = await deps.installHc((phase) => event.sender.send(Channel.hcInstallPhase, phase));
        return { installed: { version: installed.version, path: installed.path } };
      } catch (error) {
        if (error instanceof HcInstallError) return { failed: { phase: error.phase, message: error.message } };
        throw error;
      }
    },
    async noticesSupported(event) {
      assertAppFrame(event, deps.origin);
      return deps.noticesSupported();
    },
    async noticePermission(event) {
      assertAppFrame(event, deps.origin);
      return deps.noticePermission();
    },
    async showNotice(event, candidate) {
      assertAppFrame(event, deps.origin);
      if (!isDesktopNotice(candidate)) return { accepted: false, reason: "the notice was refused" };
      return deps.showNotice({ kind: candidate.kind, terminal: candidate.terminal });
    },
    async setDirectTarget(event, candidate) {
      assertAppFrame(event, deps.origin);
      if (typeof candidate !== "string") return false;
      return deps.setDirectTarget(candidate);
    },
    async forwardDirect(event) {
      assertAppFrame(event, deps.origin);
      const windowId = event.sender?.id;
      if (windowId === undefined) return { refused: "no window to forward for" };
      return deps.forwardDirect(windowId);
    },
    async cancelDirectForward(event, candidate) {
      assertAppFrame(event, deps.origin);
      if (typeof candidate !== "string") return false;
      return deps.cancelDirectForward(candidate);
    },
  };
}
