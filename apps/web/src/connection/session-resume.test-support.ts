import type { ByteLink } from "@doriface/client";
import { CloseCode, type SecureSession } from "@doriface/crypto";
import type { ResumableSession } from "./session-resume.ts";

export const link = (): ByteLink => ({ send() {}, onData: () => () => {}, onClose: () => () => {}, close() {} });
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
/** Lets the resumer's promise chain run under fake timers, where `settle` would never fire. */
export async function turns(count = 10): Promise<void> {
  if (count === 0) return;
  await Promise.resolve();
  await turns(count - 1);
}

/** The parts of a session the resumer drives, with scripted outcomes for each resume. */
export function fakeSession(outcomes: readonly ("ok" | "refused" | "revoked" | "gone" | "old-host")[]) {
  const calls = { redials: 0, resumes: 0, abandoned: [] as Error[] };
  let detached = true;
  let closed = false;
  /** Once set, every later resume ends this way, whatever the script said. */
  let from: "ok" | undefined;
  const secure = {
    get detached() {
      return detached;
    },
    get closed() {
      return closed;
    },
    resume: async (socket: ByteLink) => {
      calls.resumes += 1;
      const outcome = from ?? outcomes[Math.min(calls.resumes - 1, outcomes.length - 1)];
      if (outcome === "ok") {
        detached = false;
        return;
      }
      socket.close();
      const error = new Error(outcome);
      if (outcome === "revoked") Object.assign(error, { code: CloseCode.UnknownDevice });
      if (outcome === "gone") Object.assign(error, { code: CloseCode.ResumeRefused });
      if (outcome === "old-host") Object.assign(error, { code: CloseCode.CryptoFailure });
      throw error;
    },
    abandon: (reason: Error) => {
      calls.abandoned.push(reason);
      closed = true;
    },
  } as unknown as SecureSession;
  const session: ResumableSession = {
    secure,
    redial: async () => {
      calls.redials += 1;
      return link();
    },
  };
  return {
    session,
    calls,
    drop: () => void (detached = true),
    hostBack: () => void (from = "ok"),
  };
}
