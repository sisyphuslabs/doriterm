import { constants, createReadStream, openSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** The FIFO each connect of a silentHc writes its pid to as it starts. */
export const STARTED_FIFO = "started";

export interface SilentHc {
  readonly hc: string;
  connects(): string[];
  /** Resolves once `count` more connects have started. */
  started(count: number): Promise<void>;
  /** Ends the reader, then its stream closes the FIFO's fd: settles once no read is left on it (#1146). Idempotent. */
  close(): Promise<void>;
}

/**
 * An hc whose connect never answers the hello, keeps its output open, and exits once its input ends, as hc does. Its
 * pid file is written under another name and moved into place, so a connect-* name only appears with its pid in it
 * (`echo > name` creates the file before it writes, and an empty one read as pid 0, #365). Each connect then writes its
 * pid to a FIFO this test holds open: `started` resolves as connects start, from their own lines, where a watch on the
 * directory reports only what happens once the watch is live, which the test cannot see (#780).
 */
export function silentHc(dir: string): SilentHc {
  const hc = join(dir, "hc");
  const fifo = join(dir, STARTED_FIFO);
  if (Bun.spawnSync(["mkfifo", fifo]).exitCode !== 0) throw new Error(`mkfifo ${fifo} failed`);
  writeFileSync(
    hc,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "hc 0.1.17"; exit 0; fi\necho $$ > "${dir}/.pid-$$" && mv "${dir}/.pid-$$" "${dir}/connect-$$.pid"\necho $$ > "${fifo}"\nwhile read -r line; do :; done\n`,
    { mode: 0o755 },
  );
  // Read and write, so no connect blocks opening it and the reader never sees an end while connects come and go.
  const fd = openSync(fifo, constants.O_RDWR);
  // The stream owns the fd and closes it only once its last read has returned: a read waiting on a fd closed under it
  // is retried on that number when a signal interrupts it, and fails EBADF or reads whatever file holds it by then.
  const input = createReadStream("", { fd, autoClose: true });
  const lines = createInterface({ input });
  const reads = lines[Symbol.asyncIterator]();
  const closeInput = async (): Promise<void> => {
    lines.close();
    if (input.closed) return;
    const closed = new Promise<void>((resolve) => input.once("close", () => resolve()));
    // A destroyed stream (an errored one is too) is already closing the fd, so nothing may be written to it. A live
    // one's read waits on the FIFO until a line comes: this one returns it, so destroy can close the fd.
    if (!input.destroyed) {
      writeSync(fd, "\n");
      input.destroy();
    }
    await closed;
  };
  let closing: Promise<void> | undefined;
  return {
    hc,
    connects: () => readdirSync(dir).filter((name) => name.startsWith("connect-")),
    started: async function started(count: number): Promise<void> {
      if (count === 0) return;
      if ((await reads.next()).done === true) throw new Error("the connects' FIFO ended");
      return started(count - 1);
    },
    close: () => (closing ??= closeInput()),
  };
}
