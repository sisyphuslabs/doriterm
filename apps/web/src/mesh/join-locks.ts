/** Holds a Web Lock until the returned function is called; without Web Locks there is no other tab to tell apart. */
export function holdLock(name: string): Promise<() => void> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks === undefined) return Promise.resolve(() => undefined);
  return new Promise((acquired) => {
    void locks.request(name, () => new Promise<void>((release) => acquired(release)));
  });
}

/** The lock one join's owner holds for the join's life: its claim is live while the lock is held. */
export const enrollLock = (owner: string): string => `doriface-enroll/${owner}`;

/** Whether a join's owner is still running somewhere; without Web Locks a claim is never taken for abandoned. */
export async function liveJoin(owner: string): Promise<boolean> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks === undefined) return true;
  const { held = [] } = await locks.query();
  return held.some((lock) => lock.name === enrollLock(owner));
}
