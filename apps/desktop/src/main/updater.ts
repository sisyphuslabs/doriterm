import type { UpdateReady } from "../shared/bridge.ts";
import type { UpdateChannel, UpdateStatus } from "../shared/update.ts";

/** The update host the packaged app reads its feed from (#1969); `/desktop/<channel>/latest*.yml` under it. */
export const UPDATE_ORIGIN = "https://get.doriterm.com";
/** The origins an override (DORITERM_UPDATE_ORIGIN) may name: the hosted feed and its staging copy. */
export const UPDATE_ORIGINS: readonly string[] = [UPDATE_ORIGIN, "https://staging.get.doriterm.com"];

export const feedUrl = (origin: string, channel: UpdateChannel): string => `${origin}/desktop/${channel}`;

/** A download that has not moved for this long gets its own line in Settings; the next check tries again. */
export const STALL_MS = 10 * 60 * 1000;

/** What electron-updater hands over for an available release; `minimumVersion` is the feed's self-update floor. */
export interface AvailableUpdate {
  readonly version: string;
  readonly minimumVersion?: unknown;
}

/** The part of electron-updater's autoUpdater the watch uses. */
export interface Updater {
  autoDownload: boolean;
  on(event: "update-available", listener: (info: AvailableUpdate) => void): unknown;
  on(event: "update-not-available", listener: () => void): unknown;
  on(event: "download-progress", listener: (progress: { readonly percent: number }) => void): unknown;
  on(event: "update-downloaded", listener: (info: { readonly version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  setFeedURL(options: { readonly provider: "generic"; readonly url: string }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

/** Starts a timer and answers its cancel. */
export type StartTimer = (run: () => void, ms: number) => () => void;

const realTimer: StartTimer = (run, ms) => {
  const handle = setTimeout(run, ms);
  return () => clearTimeout(handle);
};

export interface WatchOptions {
  readonly currentVersion: string;
  readonly channel: UpdateChannel;
  readonly origin?: string;
  readonly onReady: (ready: UpdateReady) => void;
  readonly onStatus: (status: UpdateStatus) => void;
  readonly log: (line: string) => void;
  readonly timer?: StartTimer;
}

const core = (version: string): number[] => (version.split("-")[0] ?? "").split(".").map(Number);

/** Whether `version` is below `floor`: by number, then a prerelease below its release. */
export function isBelow(version: string, floor: string): boolean {
  const [a, b] = [core(version), core(floor)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return version.includes("-") && !floor.includes("-");
}

/**
 * Checks the channel's feed and downloads a newer release in the background. electron-updater's staged rollout decides
 * whether this install is offered it (the feed's stagingPercentage against the id it keeps in userData); the watch adds
 * the self-update floor, a stall timer, and a status the page shows as one line per state. Once a release is staged it
 * is ready: Restart to update quits into it, and unrestarted it installs when the app next quits.
 */
export class UpdateWatch {
  #status: UpdateStatus = { state: "idle" };
  #channel: UpdateChannel;
  #cancelStall: () => void = () => undefined;
  readonly #updater: Updater;
  readonly #options: WatchOptions;
  readonly #timer: StartTimer;

  constructor(updater: Updater, options: WatchOptions) {
    this.#updater = updater;
    this.#options = options;
    this.#channel = options.channel;
    this.#timer = options.timer ?? realTimer;
  }

  get ready(): UpdateReady | null {
    return this.#status.state === "ready" ? { version: this.#status.version } : null;
  }

  get status(): UpdateStatus {
    return this.#status;
  }

  get channel(): UpdateChannel {
    return this.#channel;
  }

  #set(status: UpdateStatus): void {
    this.#status = status;
    this.#options.onStatus(status);
  }

  #fail(reason: "check" | "download" | "stalled" | "below-floor", message: string): void {
    this.#cancelStall();
    this.#options.log(`update ${reason}: ${message}`);
    this.#set({ state: "failed", reason, message });
  }

  #armStall(version: string): void {
    this.#cancelStall();
    this.#cancelStall = this.#timer(
      () => this.#fail("stalled", `The download of ${version} stopped making progress; the next check tries again.`),
      STALL_MS,
    );
  }

  #feed(): void {
    this.#updater.setFeedURL({
      provider: "generic",
      url: feedUrl(this.#options.origin ?? UPDATE_ORIGIN, this.#channel),
    });
  }

  start(): void {
    const updater = this.#updater;
    updater.autoDownload = false;
    updater.on("update-not-available", () => this.#set({ state: "current" }));
    updater.on("update-available", (info) => this.#available(info));
    updater.on("download-progress", (progress) => {
      if (this.#status.state !== "downloading") return;
      this.#armStall(this.#status.version);
      this.#set({ ...this.#status, percent: Math.round(progress.percent) });
    });
    updater.on("update-downloaded", (info) => {
      this.#cancelStall();
      this.#set({ state: "ready", version: info.version });
      this.#options.onReady({ version: info.version });
    });
    updater.on("error", (error) => {
      if (this.#status.state === "downloading") this.#fail("download", error.message);
      else if (this.#status.state === "checking") this.#fail("check", error.message);
      else this.#options.log(`update: ${error.message}`);
    });
    this.#feed();
    this.check();
  }

  #available(info: AvailableUpdate): void {
    const floor = info.minimumVersion;
    const current = this.#options.currentVersion;
    if (typeof floor === "string" && isBelow(current, floor)) {
      return this.#fail(
        "below-floor",
        `Doriterm ${current} is older than ${floor}, the oldest version that can update itself to ${info.version}. Download ${info.version} from get.doriterm.com.`,
      );
    }
    this.#set({ state: "downloading", version: info.version, percent: 0 });
    this.#armStall(info.version);
    this.#updater.downloadUpdate().catch((error: unknown) => {
      if (this.#status.state === "downloading")
        this.#fail("download", error instanceof Error ? error.message : String(error));
    });
  }

  /** One check; skipped while one runs, while a download runs, and once a release is staged. */
  check(): void {
    const { state } = this.#status;
    if (state === "checking" || state === "downloading" || state === "ready") return;
    this.#set({ state: "checking" });
    this.#updater.checkForUpdates().then(
      // A check that settles without an answer event (no feed configured) leaves nothing pending.
      () => this.#status.state === "checking" && this.#set({ state: "idle" }),
      (error: unknown) => {
        if (this.#status.state === "checking")
          this.#fail("check", error instanceof Error ? error.message : String(error));
      },
    );
  }

  /** Reads the other channel's feed from the next check on, which runs at once unless a release is already staged. */
  setChannel(channel: UpdateChannel): void {
    this.#channel = channel;
    this.#feed();
    if (this.#status.state === "failed" || this.#status.state === "current") this.#set({ state: "idle" });
    this.check();
  }

  /** Quits and installs the staged update; false when none is staged. */
  install(): boolean {
    if (this.#status.state !== "ready") return false;
    this.#updater.quitAndInstall();
    return true;
  }
}
