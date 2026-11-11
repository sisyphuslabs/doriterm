import type { UpdateReady } from "../shared/bridge.ts";

/** The part of electron-updater's autoUpdater the watch uses. */
export interface Updater {
  on(event: "update-downloaded", listener: (info: { readonly version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

/**
 * Checks for a release and downloads it in the background (electron-updater's autoDownload). Once one is staged it is
 * ready: the page is told, and Restart to update quits into it. Unrestarted, it installs when the app next quits.
 */
export class UpdateWatch {
  #ready: UpdateReady | null = null;
  readonly #updater: Updater;
  readonly #onReady: (ready: UpdateReady) => void;
  readonly #log: (line: string) => void;

  constructor(updater: Updater, onReady: (ready: UpdateReady) => void, log: (line: string) => void) {
    this.#updater = updater;
    this.#onReady = onReady;
    this.#log = log;
  }

  get ready(): UpdateReady | null {
    return this.#ready;
  }

  start(): void {
    this.#updater.on("update-downloaded", (info) => {
      this.#ready = { version: info.version };
      this.#onReady(this.#ready);
    });
    this.#updater.on("error", (error) => this.#log(`update: ${error.message}`));
    this.check();
  }

  check(): void {
    this.#updater.checkForUpdates().catch((error: unknown) => {
      this.#log(`update check: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Quits and installs the staged update; false when none is staged. */
  install(): boolean {
    if (this.#ready === null) return false;
    this.#updater.quitAndInstall();
    return true;
  }
}
