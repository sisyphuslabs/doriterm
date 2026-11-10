import { expect, test } from "bun:test";
import { onLink } from "./remote-ops-link.ts";

test("a pairing stage that fails still closes the relay link, and its error reaches the caller", async () => {
  let closed = 0;
  const link = { close: () => (closed += 1) };
  const noise = onLink(link, () => Promise.reject(new Error("pair.noise failed")));
  await expect(noise).rejects.toThrow("pair.noise failed");
  expect(closed).toBe(1);
});

test("stages that succeed close the link once and return their value", async () => {
  let closed = 0;
  const link = { close: () => (closed += 1) };
  expect(await onLink(link, async () => "hello")).toBe("hello");
  expect(closed).toBe(1);
});
