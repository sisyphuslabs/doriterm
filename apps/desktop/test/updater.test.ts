import { describe, expect, test } from "bun:test";
import { UpdateWatch, type Updater } from "../src/main/updater.ts";

/** electron-updater's autoUpdater as far as the watch uses it: its events are fired by hand. */
function fakeUpdater(check: () => Promise<unknown> = async () => null) {
  const listeners = new Map<string, ((value: never) => void)[]>();
  let checks = 0;
  let installs = 0;
  const updater: Updater = {
    on(event: string, listener: (value: never) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return updater;
    },
    async checkForUpdates() {
      checks += 1;
      return check();
    },
    quitAndInstall() {
      installs += 1;
    },
  };
  const emit = (event: string, value: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(value as never);
  };
  return { updater, emit, checks: () => checks, installs: () => installs };
}

describe("UpdateWatch", () => {
  test("a staged update is ready: the page is told its version, and Restart installs it", async () => {
    const fake = fakeUpdater();
    const told: unknown[] = [];
    const watch = new UpdateWatch(
      fake.updater,
      (ready) => told.push(ready),
      () => undefined,
    );
    watch.start();
    expect(fake.checks()).toBe(1);
    expect(watch.ready).toBeNull();
    expect(watch.install()).toBe(false);
    expect(fake.installs()).toBe(0);

    fake.emit("update-downloaded", { version: "0.2.0", files: [] });
    expect(told).toEqual([{ version: "0.2.0" }]);
    expect(watch.ready).toEqual({ version: "0.2.0" });
    expect(watch.install()).toBe(true);
    expect(fake.installs()).toBe(1);
  });

  test("a check that fails is logged, not thrown, and nothing is ready", async () => {
    const fake = fakeUpdater(async () => {
      throw new Error("latest-linux.yml: 404");
    });
    const logged: string[] = [];
    const { promise: checkLogged, resolve } = Promise.withResolvers<void>();
    const watch = new UpdateWatch(
      fake.updater,
      () => undefined,
      (line) => {
        logged.push(line);
        if (line.startsWith("update check:")) resolve();
      },
    );
    watch.start();
    fake.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));
    await checkLogged;
    expect(logged).toEqual(["update: net::ERR_INTERNET_DISCONNECTED", "update check: latest-linux.yml: 404"]);
    expect(watch.ready).toBeNull();
    expect(watch.install()).toBe(false);
    expect(fake.installs()).toBe(0);
  });
});
