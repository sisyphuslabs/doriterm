import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { E2E_SLOT, hostPortOf } from "./config.ts";
import { startWorkerHost } from "./worker-host.ts";

/** The report on doriface-host's `startup-error` line in `text`, if there is one. */
function startupError(text: string): Record<string, unknown> | undefined {
  const prefix = "doriface-host startup-error ";
  const line = text.split("\n").find((l) => l.trimStart().startsWith(prefix));
  return line === undefined
    ? undefined
    : (JSON.parse(line.trimStart().slice(prefix.length)) as Record<string, unknown>);
}

test("a worker host whose port another process holds fails setup with that cause, not a clean exit (#1279)", async () => {
  const port = hostPortOf(E2E_SLOT);
  // Holds the port without answering HTTP, as the local end of an outgoing connection does: the worker's `already
  // answers` check passes, and the host's own listen is refused.
  const holder = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));
  try {
    const error = await startWorkerHost().then(
      () => undefined,
      (failure: unknown) => (failure instanceof Error ? failure.message : String(failure)),
    );
    expect(error).toBeDefined();
    expect(error).not.toContain("(exit 0)");
    expect(startupError(error ?? "")).toMatchObject({ code: "port-in-use", address: `127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
}, 150_000);
