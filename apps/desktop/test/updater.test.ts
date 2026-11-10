import { describe, expect, test } from "bun:test";
import type { UpdateStatus } from "../src/shared/update.ts";
import { isBelow, STALL_MS, type Updater, UpdateWatch } from "../src/main/updater.ts";

/** electron-updater's autoUpdater as far as the watch uses it: its events are fired by hand. */
function fakeUpdater(check: () => Promise<unknown> = async () => null) {
  const listeners = new Map<string, ((value: never) => void)[]>();
  const calls = { checks: 0, downloads: 0, installs: 0, feeds: [] as string[] };
  const updater: Updater = {
    autoDownload: true,
    on(event: string, listener: (value: never) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return updater;
    },
    setFeedURL(options) {
      calls.feeds.push(`${options.provider} ${options.url}`);
    },
    async checkForUpdates() {
      calls.checks += 1;
      return check();
    },
    async downloadUpdate() {
      calls.downloads += 1;
      return [];
    },
    quitAndInstall() {
      calls.installs += 1;
    },
  };
  const emit = (event: string, value?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(value as never);
  };
  return { updater, emit, calls };
}

/** A timer the test fires by hand: the stall line must not wait ten real minutes. */
function manualTimer() {
  const pending: { run: () => void; ms: number; live: boolean }[] = [];
  const start = (run: () => void, ms: number) => {
    const entry = { run, ms, live: true };
    pending.push(entry);
    return () => {
      entry.live = false;
    };
  };
  const fire = () => pending.filter((entry) => entry.live).forEach((entry) => entry.run());
  return { start, fire, live: () => pending.filter((entry) => entry.live).map((entry) => entry.ms) };
}

function watch(version = "0.1.16", check?: () => Promise<unknown>) {
  const fake = fakeUpdater(check);
  const timer = manualTimer();
  const statuses: UpdateStatus[] = [];
  const ready: unknown[] = [];
  const logged: string[] = [];
  const updates = new UpdateWatch(fake.updater, {
    currentVersion: version,
    channel: "stable",
    onReady: (staged) => ready.push(staged),
    onStatus: (status) => statuses.push(status),
    log: (line) => logged.push(line),
    timer: timer.start,
  });
  return { ...fake, timer, statuses, ready, logged, updates };
}

describe("UpdateWatch", () => {
  test("it reads get.doriterm.com's stable feed, downloads what is offered and stages it for Restart to update", () => {
    const w = watch();
    w.updates.start();
    expect(w.updater.autoDownload).toBe(false);
    expect(w.calls.feeds).toEqual(["generic https://get.doriterm.com/desktop/stable"]);
    expect(w.calls.checks).toBe(1);
    expect(w.updates.install()).toBe(false);
    w.emit("update-available", { version: "0.1.17", minimumVersion: "0.1.10" });
    w.emit("download-progress", { percent: 41.6 });
    w.emit("update-downloaded", { version: "0.1.17" });
    expect(w.calls.downloads).toBe(1);
    expect(w.statuses).toEqual([
      { state: "checking" },
      { state: "downloading", version: "0.1.17", percent: 0 },
      { state: "downloading", version: "0.1.17", percent: 42 },
      { state: "ready", version: "0.1.17" },
    ]);
    expect(w.ready).toEqual([{ version: "0.1.17" }]);
    expect(w.timer.live()).toEqual([]);
    w.updates.check();
    expect(w.calls.checks).toBe(1);
    expect(w.updates.install()).toBe(true);
    expect(w.calls.installs).toBe(1);
  });

  test("a check that fails has its own line, once, and the next check runs again", async () => {
    const w = watch("0.1.16", async () => {
      throw new Error("latest-linux.yml: 404");
    });
    w.updates.start();
    w.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));
    await Bun.sleep(0);
    expect(w.statuses).toEqual([
      { state: "checking" },
      { state: "failed", reason: "check", message: "net::ERR_INTERNET_DISCONNECTED" },
    ]);
    w.updates.check();
    expect(w.calls.checks).toBe(2);
    expect(w.updates.ready).toBeNull();
  });

  test("a build below the feed's floor is told so and downloads nothing", () => {
    const w = watch("0.1.9");
    w.updates.start();
    w.emit("update-available", { version: "0.1.17", minimumVersion: "0.1.10" });
    expect(w.calls.downloads).toBe(0);
    expect(w.statuses.at(-1)).toEqual({
      state: "failed",
      reason: "below-floor",
      message:
        "Doriterm 0.1.9 is older than 0.1.10, the oldest version that can update itself to 0.1.17. Download 0.1.17 from get.doriterm.com.",
    });
  });

  test("a download that stops moving is reported as stalled; progress restarts the clock", () => {
    const w = watch();
    w.updates.start();
    w.emit("update-available", { version: "0.1.17" });
    expect(w.timer.live()).toEqual([STALL_MS]);
    w.emit("download-progress", { percent: 10 });
    expect(w.timer.live()).toEqual([STALL_MS]);
    w.timer.fire();
    expect(w.statuses.at(-1)).toEqual({
      state: "failed",
      reason: "stalled",
      message: "The download of 0.1.17 has made no progress for ten minutes; it keeps waiting on the connection.",
    });
    w.emit("error", new Error("late"));
    expect(w.logged.at(-1)).toBe("update: late");
  });

  test("an error during a download is a download failure, and an up-to-date answer says so", () => {
    const w = watch();
    w.updates.start();
    w.emit("update-not-available");
    expect(w.statuses.at(-1)).toEqual({ state: "current" });
    w.updates.check();
    w.emit("update-available", { version: "0.1.17" });
    w.emit("error", new Error("sha512 checksum mismatch"));
    expect(w.statuses.at(-1)).toEqual({ state: "failed", reason: "download", message: "sha512 checksum mismatch" });
  });

  test("choosing beta points the feed at the beta channel and checks it at once", () => {
    const w = watch();
    w.updates.start();
    w.emit("update-not-available");
    w.updates.setChannel("beta");
    expect(w.updates.channel).toBe("beta");
    expect(w.calls.feeds.at(-1)).toBe("generic https://get.doriterm.com/desktop/beta");
    expect(w.calls.checks).toBe(2);
  });
});

test("a version is below a floor by its numbers, and a prerelease is below its own release", () => {
  const cases: [string, string, boolean][] = [
    ["0.1.9", "0.1.10", true],
    ["0.1.10", "0.1.10", false],
    ["0.2.0", "0.1.10", false],
    ["1.0.0", "0.9.9", false],
    ["0.1.10-rc.1", "0.1.10", true],
    ["0.1.10", "0.1.10-rc.1", false],
  ];
  for (const [version, floor, below] of cases)
    expect([version, floor, isBelow(version, floor)]).toEqual([version, floor, below]);
});
