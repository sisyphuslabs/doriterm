import { HcConnectionClosedError } from "@doriface/client";
import { SecureLinkError } from "@doriface/crypto";
import { RelayCloseError } from "@doriface/relay-client";
import { LinkCloseError } from "../connection/ws-link.ts";
import { afterEach, expect, jest, test } from "bun:test";
import { AttachRecovery, droppedStreamCause } from "./attach-recovery.ts";

afterEach(() => jest.useRealTimers());

/** What a relayed stream's close carries: the secured link's error over the relay's, with the relay's close code. */
const overRelay = (code: number, reason: string): SecureLinkError =>
  new SecureLinkError(code, `relay socket closed with ${code}: ${reason}`, {
    cause: new RelayCloseError(code, reason),
  });

/** A stream attached once, then ended by its connection with `error`: how many times recovery re-attaches it. */
function dropped(error: Error | undefined) {
  jest.useFakeTimers();
  let reattaches = 0;
  const recovery = new AttachRecovery(
    () => {
      if (recovery.begin()) reattaches += 1;
    },
    () => {},
  );
  recovery.begin();
  recovery.succeeded();
  const cause = droppedStreamCause(error);
  recovery.failed(cause);
  jest.advanceTimersByTime(2_000);
  return { cause, state: recovery.state, reattaches };
}

test("a stream dropped by a 1011 relay close re-attaches by itself (#2224)", () => {
  const { cause, state, reattaches } = dropped(overRelay(1011, "relay blip"));
  expect(cause).toBeInstanceOf(HcConnectionClosedError);
  expect(state).toMatchObject({ phase: "reconnecting", transient: true });
  expect(reattaches).toBe(1);
});

test("a stream dropped by a 4408 secured-link close re-attaches though its cause carries 4400: the top-level code decides", () => {
  // How a session resumer reports a resume it abandoned (#2000): the idle timeout over the refusal that ended the resume.
  const abandoned = new SecureLinkError(4408, "idle timeout", { cause: new SecureLinkError(4400, "crypto failure") });
  const { cause, state, reattaches } = dropped(abandoned);
  expect(cause).toBeInstanceOf(HcConnectionClosedError);
  expect(state).toMatchObject({ phase: "reconnecting", transient: true });
  expect(reattaches).toBe(1);
});

test("a stream dropped with no error from the link re-attaches by itself", () => {
  const { cause, reattaches } = dropped(undefined);
  expect(cause).toBeInstanceOf(HcConnectionClosedError);
  expect(reattaches).toBe(1);
});

test.each([
  ["a 4401 relay close (unknown device)", overRelay(4401, "unknown device")],
  ["a 4400 secured-link close (crypto failure)", new SecureLinkError(4400, "crypto failure")],
  ["a 4403 relay close (auth refused)", new RelayCloseError(4403, "auth refused")],
  ["a 4401 direct-link close", new LinkCloseError(4401, "unknown device")],
] as const)("a stream dropped by %s offers Try again at once and never retries", (_, error) => {
  const { cause, state, reattaches } = dropped(error);
  expect(cause).toBe(error);
  expect(state).toMatchObject({ phase: "failed", transient: false });
  expect(reattaches).toBe(0);
});
