import { controlIsLive, controlSocketPath } from "../control.ts";

export const WAIT_POLL_MS = 200;

export const pause = (deadline: number): Promise<void> =>
  Bun.sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));

export function waitSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--wait-host wants a positive number of seconds, got ${JSON.stringify(value)}`);
  }
  return seconds;
}

/** Polls the state dir's control socket until a running host answers, so what follows is that host's answer, never a file. */
export async function waitForHost(stateDir: string, deadline: number, out: (text: string) => void): Promise<void> {
  if (await controlIsLive(stateDir)) return;
  const seconds = Math.ceil((deadline - Date.now()) / 1000);
  out(`Waiting for doriface-host to start (up to ${seconds} s)...\n`);
  const poll = async (): Promise<boolean> => {
    if (Date.now() >= deadline) return false;
    await pause(deadline);
    return (await controlIsLive(stateDir)) || poll();
  };
  if (await poll()) return;
  throw new Error(
    `no running doriface-host answered on ${controlSocketPath(stateDir)} in time; check that the service started`,
  );
}
