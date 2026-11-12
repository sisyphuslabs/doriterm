import { type ByteLink, CloseCode, SecureLinkError, type Unsubscribe } from "./link.ts";
import {
  decodeResumeAnswer,
  decodeResumeRequest,
  encodeResumeAnswer,
  encodeResumeRequest,
  type RecordCounters,
  RESUME_ANSWER_TIMEOUT_MS,
  type ResumeKeys,
} from "./resume.ts";

/** What the resume exchange needs from a session: its identity, its position, its kept records, and a new link to bind. */
export interface ResumableSession {
  readonly closed: boolean;
  readonly detached: boolean;
  readonly resumeKeys: ResumeKeys;
  readonly counters: RecordCounters;
  /** The records sent from sequence number `sequence` on, or undefined when they are no longer held. */
  replayFrom(sequence: number): readonly Uint8Array[] | undefined;
  /** Carries the session on over `link`; `pending` arrived on it before the session listened and is opened first. */
  rebind(link: ByteLink, pending: readonly Uint8Array[]): void;
}

const NORMAL_CLOSE = 1000;
const NOT_SUBSCRIBED: Unsubscribe = () => undefined;

interface Opened {
  readonly first: Uint8Array;
  /** Stops listening and returns what arrived after the first message, in order. */
  readonly drain: () => Uint8Array[];
}

/**
 * Sends `request` on a fresh link and resolves with the first message back. The listener stays on the link until
 * `drain`, keeping what follows in order: a link delivers to nobody what arrives while no one listens, and the records
 * the responder sends right after its answer must not be lost to the gap before the session binds the link.
 */
function open(link: ByteLink, request: Uint8Array, timeoutMs: number): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const later: Uint8Array[] = [];
    let first: Uint8Array | undefined;
    let done = false;
    let unsubscribeData: Unsubscribe = NOT_SUBSCRIBED;
    let unsubscribeClose: Unsubscribe = NOT_SUBSCRIBED;
    const drain = (): Uint8Array[] => {
      unsubscribeData();
      unsubscribeClose();
      return later.splice(0);
    };
    const fail = (error: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      drain();
      link.close(CloseCode.IdleTimeout, error.message);
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new SecureLinkError(CloseCode.IdleTimeout, "no resume answer in time")),
      timeoutMs,
    );
    unsubscribeData = link.onData((bytes) => {
      if (first !== undefined) return void later.push(bytes);
      first = bytes;
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribeClose();
      resolve({ first, drain });
    });
    unsubscribeClose = link.onClose((error) =>
      fail(error ?? new SecureLinkError(undefined, "the link closed before the resume was answered")),
    );
    try {
      link.send(request);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Whether the peer's position lets this side carry on exactly: it has sent at least what this side opened, and what it
 * opened is no further than this side sent and no further back than the records this side still holds.
 */
function joinable(
  mine: RecordCounters,
  peer: RecordCounters,
  replay: readonly Uint8Array[] | undefined,
): replay is readonly Uint8Array[] {
  return peer.sent >= mine.received && peer.received <= mine.sent && replay !== undefined;
}

/**
 * Initiator: asks the responder to carry the detached session on over `link`, then sends it the records it missed. The
 * link is closed and the promise rejects when the responder refuses, answers wrongly or does not answer in time; the
 * session stays detached then, for another try or for closing.
 */
export async function resumeOn(
  session: ResumableSession,
  link: ByteLink,
  timeoutMs = RESUME_ANSWER_TIMEOUT_MS,
): Promise<void> {
  if (session.closed || !session.detached) {
    link.close(NORMAL_CLOSE, "nothing to resume");
    throw new SecureLinkError(undefined, "the session is not detached");
  }
  const mine = session.counters;
  const { first, drain } = await open(link, encodeResumeRequest(session.resumeKeys, mine), timeoutMs);
  const answer = decodeResumeAnswer(session.resumeKeys, mine, first);
  if (answer === undefined) {
    drain();
    link.close(CloseCode.CryptoFailure, "not a resume answer");
    throw new SecureLinkError(CloseCode.CryptoFailure, "the host's answer was not a resume answer for this session");
  }
  const replay = session.replayFrom(answer.received);
  if (session.closed || !session.detached || !joinable(mine, answer, replay)) {
    drain();
    link.close(CloseCode.ResumeRefused, "positions do not meet");
    throw new SecureLinkError(CloseCode.ResumeRefused, "the host's position cannot be joined to this session's");
  }
  for (const record of replay) link.send(record);
  session.rebind(link, drain());
}

/**
 * Responder: `request` is the first message on `link`, and `pending` what followed it before this call. When it names
 * this session, proves its keys and carries a position this side can join, the answer and the records the client missed
 * go out on `link` and the session carries on over it; a request this side cannot honour returns false and leaves the
 * session as it was, for the caller to close `link`.
 */
export function acceptResume(
  session: ResumableSession,
  link: ByteLink,
  request: Uint8Array,
  pending: readonly Uint8Array[] = [],
): boolean {
  if (session.closed) return false;
  const theirs = decodeResumeRequest(session.resumeKeys, request);
  if (theirs === undefined) return false;
  const mine = session.counters;
  const replay = session.replayFrom(theirs.received);
  if (!joinable(mine, theirs, replay)) return false;
  link.send(encodeResumeAnswer(session.resumeKeys, theirs, mine));
  for (const record of replay) link.send(record);
  session.rebind(link, pending);
  return true;
}
