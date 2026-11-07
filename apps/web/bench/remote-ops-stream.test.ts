import { expect, test } from "bun:test";
import { firstOutput } from "./remote-ops-stream.ts";

test("the first paint a stream already held, delivered inside onData, is timed and unsubscribed", async () => {
  let listening = 0;
  const stream = {
    onData(listener: (bytes: Uint8Array) => void) {
      listening += 1;
      listener(Uint8Array.of(1));
      return () => {
        listening -= 1;
      };
    },
  };
  expect(await firstOutput(stream, performance.now(), 1_000)).toBeGreaterThanOrEqual(0);
  expect(listening).toBe(0);
});
