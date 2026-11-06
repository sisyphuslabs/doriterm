import type { PushClientLine, PushHostLine } from "@doriface/protocol";

/** One E2EE push session as an exchange needs it: one request, then closed. */
export interface PushExchange {
  request(line: PushClientLine): Promise<PushHostLine>;
  close(): void;
}

/** A promise that rejects once `ms` have passed: the whole exchange's deadline. */
export function deadlineAfter(ms: number): { readonly expired: Promise<never>; readonly cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("the host did not answer")), ms);
  });
  return { expired, cancel: () => clearTimeout(timer) };
}

/**
 * One line over a fresh session, the whole of it inside `expired`: finding the route, opening the link and the
 * host's reply. A session that opens after the deadline sends nothing (a late answer could press a key the caller has
 * already given up on) and is closed as soon as it opens.
 */
export async function exchangeWithin(
  open: () => Promise<PushExchange>,
  line: PushClientLine,
  expired: Promise<never>,
): Promise<PushHostLine> {
  let late = false;
  expired.catch(() => {
    late = true;
  });
  const opening = open();
  const asked = opening.then((session) => {
    if (late) throw new Error("the host did not answer");
    return session.request(line);
  });
  try {
    return await Promise.race([asked, expired]);
  } finally {
    asked.catch(() => undefined);
    void opening.then(
      (session) => session.close(),
      () => undefined,
    );
  }
}
