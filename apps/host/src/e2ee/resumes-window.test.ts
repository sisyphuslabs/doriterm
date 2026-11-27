import type { SecureSession } from "@doriface/crypto";
import { afterEach, describe, expect, jest, test } from "bun:test";
import { dropped } from "../testing/resume-harness.ts";
import { MAX_DETACHED_SESSIONS, ResumableSessions } from "./resumes.ts";

/** A session the window only watches: it detaches when told, and records the close the window gives it. */
function detachable(seed = 3) {
  const detach: ((reason: Error) => void)[] = [];
  const links: (() => void)[] = [];
  const closes: (() => void)[] = [];
  let detached = false;
  let closedWith: number | undefined;
  const session = {
    resumeKeys: { id: new Uint8Array(16).fill(seed) },
    get detached() {
      return detached && closedWith === undefined;
    },
    allowResume() {},
    onDetached: (listener: (reason: Error) => void) => (detach.push(listener), () => undefined),
    onLink: (listener: () => void) => (links.push(listener), () => undefined),
    onClose: (listener: () => void) => (closes.push(listener), () => undefined),
    close: (code: number) => {
      if (closedWith !== undefined) return;
      closedWith = code;
      for (const listener of closes) listener();
    },
  } as unknown as SecureSession;
  return {
    session,
    detach: () => {
      detached = true;
      for (const listener of detach) listener(dropped());
    },
    resume: () => {
      detached = false;
      for (const listener of links) listener();
    },
    closedWith: () => closedWith,
  };
}

describe("the resume window", () => {
  afterEach(() => jest.useRealTimers());

  test("keeps a detached session for a phone away five minutes in another app, and ends it at ten (#2853)", () => {
    jest.useFakeTimers();
    const phone = detachable();
    new ResumableSessions(() => undefined).register(phone.session);
    phone.detach();
    jest.advanceTimersByTime(5 * 60_000);
    expect(phone.closedWith()).toBeUndefined();
    jest.advanceTimersByTime(5 * 60_000);
    expect(phone.closedWith()).toBe(4408);
  });

  test(`holds at most ${MAX_DETACHED_SESSIONS} sessions waiting: one more ends the one that has waited longest, and a resumed one no longer counts (#2853)`, () => {
    jest.useFakeTimers();
    const sessions = new ResumableSessions(() => undefined);
    const phones = Array.from({ length: MAX_DETACHED_SESSIONS + 2 }, (_, at) => detachable(at + 1));
    for (const phone of phones) sessions.register(phone.session);
    for (const phone of phones.slice(0, MAX_DETACHED_SESSIONS)) {
      phone.detach();
      jest.advanceTimersByTime(1_000);
    }
    expect(sessions.detached).toBe(MAX_DETACHED_SESSIONS);
    // The second phone came back: it waits no more, so the next drop fits without ending anyone.
    phones[1]?.resume();
    phones[MAX_DETACHED_SESSIONS]?.detach();
    expect(phones.map((phone) => phone.closedWith()).filter((code) => code !== undefined)).toEqual([]);
    // Full again: the next drop ends the one that has waited longest, the first phone.
    phones[MAX_DETACHED_SESSIONS + 1]?.detach();
    expect(phones[0]?.closedWith()).toBe(4408);
    expect(
      phones
        .slice(1)
        .map((phone) => phone.closedWith())
        .filter((code) => code !== undefined),
    ).toEqual([]);
    expect(sessions.detached).toBe(MAX_DETACHED_SESSIONS);
  });
});
