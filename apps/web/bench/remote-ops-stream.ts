import type { TerminalStream } from "@doriface/client";

const now = (): number => performance.now();
const decoder = new TextDecoder();

/** Resolves when `stream` has been quiet for `quietMs`, or after `capMs`. */
export function quiet(stream: TerminalStream, quietMs: number, capMs: number): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, quietMs);
    const cap = setTimeout(done, capMs);
    const off = stream.onData(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    function done(): void {
      clearTimeout(timer);
      clearTimeout(cap);
      off();
      resolve();
    }
  });
}

/** Resolves with the time to the stream's first output, or rejects after `timeoutMs`. */
export function firstOutput(
  stream: Pick<TerminalStream, "onData">,
  started: number,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let off: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off?.();
      reject(new Error(`no first paint within ${timeoutMs} ms`));
    }, timeoutMs);
    // The first listener on a stream gets the output it held synchronously, inside onData: off is not assigned yet then.
    off = stream.onData(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off?.();
      resolve(now() - started);
    });
    if (settled) off();
  });
}

/** Types one character and resolves when the terminal echoes it. */
export function echo(stream: TerminalStream, char: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = now();
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no echo of ${char} within ${timeoutMs} ms`));
    }, timeoutMs);
    const off = stream.onData((bytes) => {
      if (!decoder.decode(bytes).includes(char)) return;
      clearTimeout(timer);
      off();
      resolve(now() - started);
    });
    stream.write(char);
  });
}

/** Runs `run` for each item, one after another: every sample is one operation alone on the link. */
export async function inTurn<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  const [first, ...rest] = items;
  if (first === undefined) return;
  await run(first);
  return inTurn(rest, run);
}
