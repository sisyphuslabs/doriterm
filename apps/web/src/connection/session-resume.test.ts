import { CloseCode } from "@doriface/crypto";
import { afterEach, describe, expect, jest, test } from "bun:test";
import { RESUME_BACKOFF_MS, ResumeAbandonedError, SessionResumer } from "./session-resume.ts";
import { fakeSession, settle, turns } from "./session-resume.test-support.ts";

afterEach(() => jest.useRealTimers());

describe("SessionResumer", () => {
  test("dials once and resumes, saying so while it does", async () => {
    const { session, calls } = fakeSession(["ok"]);
    const resuming: boolean[] = [];
    const resumer = new SessionResumer(session, { resuming: (on) => resuming.push(on) });
    resumer.start(new Error("dropped"));
    expect(resumer.active).toBe(true);
    await settle();
    expect(calls).toMatchObject({ redials: 1, resumes: 1, abandoned: [] });
    expect(resuming).toEqual([true, false]);
    expect(resumer.active).toBe(false);
    // A second start while attached does nothing.
    resumer.start(new Error("again"));
    await settle();
    expect(calls.redials).toBe(1);
  });

  test("dials again after a backoff while the resume fails, and a wake cuts the wait short", async () => {
    const { session, calls } = fakeSession(["refused", "refused", "ok"]);
    let now = 0;
    const resumer = new SessionResumer(session, { resuming: () => undefined, now: () => now });
    resumer.start(new Error("dropped"));
    await settle();
    expect(calls.resumes).toBe(1);
    // Waiting out the first backoff: nothing is dialed meanwhile.
    await settle();
    expect(calls.resumes).toBe(1);
    resumer.now();
    await settle();
    expect(calls.resumes).toBe(2);
    resumer.now();
    await settle();
    expect(calls).toMatchObject({ redials: 3, resumes: 3, abandoned: [] });
    expect(resumer.active).toBe(false);
    expect(RESUME_BACKOFF_MS.slice(0, 3)).toEqual([250, 250, 500]);
  });

  test("gives the session up with the last failure once the budget is spent, and at once when the host refuses the device", async () => {
    jest.useFakeTimers();
    const spent = fakeSession(["refused"]);
    let now = 0;
    const resumer = new SessionResumer(
      spent.session,
      { resuming: () => undefined, now: () => now, hidden: () => false },
      1_000,
    );
    resumer.start(new Error("dropped"));
    await turns();
    now = 2_000;
    jest.advanceTimersByTime(RESUME_BACKOFF_MS[0]);
    await turns();
    jest.useRealTimers();
    expect(spent.calls.abandoned.map((error) => error.message)).toEqual(["could not resume the session: refused"]);
    expect(spent.calls.abandoned[0]).toMatchObject({ code: CloseCode.IdleTimeout });
    expect(resumer.active).toBe(false);

    const revoked = fakeSession(["revoked"]);
    const once = new SessionResumer(revoked.session, { resuming: () => undefined });
    once.start(new Error("dropped"));
    await settle();
    expect(revoked.calls.resumes).toBe(1);
    expect(revoked.calls.abandoned.length).toBe(1);
  });

  test("gives the session up at once when the host refuses the resume (4413): another dial meets the same answer", async () => {
    const { session, calls } = fakeSession(["gone", "ok"]);
    const resuming: boolean[] = [];
    const resumer = new SessionResumer(session, { resuming: (on) => resuming.push(on) });
    resumer.start(new Error("dropped"));
    await settle();
    expect(calls.redials).toBe(1);
    expect(calls.abandoned.length).toBe(1);
    expect(calls.abandoned[0]?.cause).toMatchObject({ code: CloseCode.ResumeRefused });
    expect(resuming).toEqual([true, false]);
    expect(resumer.active).toBe(false);
  });

  test("gives the session up at once when a host from before resume refuses the request as an unknown kind (4400)", async () => {
    const { session, calls } = fakeSession(["old-host", "ok"]);
    const resumer = new SessionResumer(session, { resuming: () => undefined });
    resumer.start(new Error("dropped"));
    await settle();
    expect(calls.redials).toBe(1);
    expect(calls.abandoned.length).toBe(1);
    expect(calls.abandoned[0]?.cause).toMatchObject({ code: CloseCode.CryptoFailure });
    // What the streams see is the wrapper's own code, a drop to re-attach on the new session (4408), never the raw 4400
    // a pane would read as final (#2256).
    expect(calls.abandoned[0]).toBeInstanceOf(ResumeAbandonedError);
    expect(calls.abandoned[0]).toMatchObject({ code: CloseCode.IdleTimeout });
    expect(resumer.active).toBe(false);
  });

  test("reports each failed attempt while it keeps dialing, so the page can say why the host is not back yet", async () => {
    const { session } = fakeSession(["refused", "ok"]);
    const failures: string[] = [];
    const resumer = new SessionResumer(session, {
      resuming: () => undefined,
      failed: (error) => failures.push(error.message),
    });
    resumer.start(new Error("dropped"));
    await settle();
    expect(failures).toEqual(["refused"]);
    resumer.now();
    await settle();
    expect(failures).toEqual(["refused"]);
    expect(resumer.active).toBe(false);
  });

  test("stop ends the dialing without giving the session up", async () => {
    const { session, calls } = fakeSession(["refused"]);
    const resuming: boolean[] = [];
    const resumer = new SessionResumer(session, { resuming: (on) => resuming.push(on) });
    resumer.start(new Error("dropped"));
    await settle();
    resumer.stop();
    await settle();
    expect(resuming).toEqual([true, false]);
    expect(calls.abandoned).toEqual([]);
    expect(resumer.active).toBe(false);
  });
});
