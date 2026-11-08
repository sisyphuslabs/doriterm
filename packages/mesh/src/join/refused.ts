/** A join that stopped for a reason either side can print: the inviter's refusal, a check that failed, a deadline. */
export class JoinRefused extends Error {
  override readonly name = "JoinRefused";
}

/** Settles like `promise`, or rejects with `JoinRefused(reason)` once the clock reaches `at`. */
export async function byDeadline<T>(promise: Promise<T>, at: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JoinRefused(reason)), Math.max(0, at - Date.now()));
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}
