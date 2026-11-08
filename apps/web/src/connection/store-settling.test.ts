import { afterEach, expect, jest, test } from "bun:test";
import { DeviceNotPairedError } from "./connect.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { ConnectionStore } from "./store.ts";

afterEach(() => jest.useRealTimers());

test.each([true, false])("4401 retries only a view member (view=%s)", async (viewMember) => {
  jest.useFakeTimers();
  let attempts = 0;
  const store = new ConnectionStore(
    { ...DEFAULT_SETTINGS, hostId: "member", hostKey: "pinned", viewMember },
    async () => {
      attempts += 1;
      throw new DeviceNotPairedError();
    },
    () => undefined,
  );
  const failed = () =>
    new Promise<void>((resolve) => {
      const off = store.subscribe(() => {
        if (store.state.phase !== "failed") return;
        off();
        resolve();
      });
    });
  const first = failed();
  store.start();
  await first;
  if (viewMember) {
    expect(store.state).toMatchObject({ settling: true, retryInMs: 1_000 });
    if (store.state.phase === "failed") expect(store.state.error).not.toBeInstanceOf(DeviceNotPairedError);
    const second = failed();
    jest.advanceTimersByTime(1_000);
    await second;
    expect(attempts).toBe(2);
  } else {
    expect(store.state).toMatchObject({ retryInMs: null });
    jest.advanceTimersByTime(60_000);
    expect(attempts).toBe(1);
  }
  store.stop();
});
