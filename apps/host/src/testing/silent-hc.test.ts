import { describe, expect, test } from "bun:test";
import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STARTED_FIFO, silentHc } from "./silent-hc.ts";

/** The read(2) syscall number in /proc/<pid>/task/<tid>/syscall, by arch. */
const READ_SYSCALL: Readonly<Partial<Record<string, string>>> = { x64: "0", arm64: "63" };
const readSyscall = process.platform === "linux" ? READ_SYSCALL[process.arch] : undefined;
const PARK_DEADLINE_MS = 5_000;
/** Past the park deadline, so a read that never parks fails with the sampler's message, not bun's test timeout (#1312). */
const PARK_TEST_TIMEOUT_MS = 3 * PARK_DEADLINE_MS;

/** What a connect starting now meets on the FIFO: a reader, or ENXIO when no read is left on it. */
function lateConnect(fifo: string): string {
  try {
    closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    return "a reader";
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
    throw error;
  }
}

/** Whether a thread of this process is blocked in read(2) on a fd open on `path`. */
function readParkedOn(path: string): boolean {
  return readdirSync("/proc/self/task").some((tid) => {
    try {
      const [call, fd] = readFileSync(`/proc/self/task/${tid}/syscall`, "utf8").split(" ");
      return call === readSyscall && fd !== undefined && readlinkSync(`/proc/self/fd/${Number(fd)}`) === path;
    } catch {
      // The thread exited, or the fd closed, between the listing and the read.
      return false;
    }
  });
}

/** Resolves once the stream's next read is parked in the thread pool on `path`; no event says so, so it is sampled. */
async function untilReadParked(path: string, deadline = performance.now() + PARK_DEADLINE_MS): Promise<void> {
  if (readParkedOn(path)) return;
  if (performance.now() > deadline) throw new Error(`no read parked on ${path} within ${PARK_DEADLINE_MS} ms`);
  await Bun.sleep(1);
  return untilReadParked(path, deadline);
}

describe("the silent hc's FIFO (#1146)", () => {
  test.skipIf(readSyscall === undefined)(
    "close ends the read parked on the FIFO, so no read is left to retry on its closed fd",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "dh-silent-close-"));
      const fifo = join(dir, STARTED_FIFO);
      try {
        const silent = silentHc(dir);
        writeFileSync(fifo, "1\n");
        await silent.started(1);
        // The case #1146 is about: the stream's next read is already blocked on the FIFO when close runs.
        await untilReadParked(fifo);
        await silent.close();
        // A read still parked there holds the FIFO open, and a signal that wakes it retries it on a fd number that is
        // closed or another file's: the EBADF between tests of #1146. A writer opening now meets no reader. (Sampling
        // /proc here proves nothing: close has closed the fd, so its link no longer names the FIFO either way, #1313.)
        expect(lateConnect(fifo)).toBe("ENXIO");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    PARK_TEST_TIMEOUT_MS,
  );

  test("a second close resolves, and writes nothing to the fd the first one closed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dh-silent-twice-"));
    const fifo = join(dir, STARTED_FIFO);
    try {
      const silent = silentHc(dir);
      writeFileSync(fifo, "1\n");
      await silent.started(1);
      await silent.close();
      await silent.close();
      expect(lateConnect(fifo)).toBe("ENXIO");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
