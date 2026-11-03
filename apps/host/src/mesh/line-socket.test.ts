import { afterAll, describe, expect, test } from "bun:test";
import type { ByteLink } from "@doriface/crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenLineSocket, MAX_EARLY_BYTES, MAX_QUEUED_BYTES } from "./line-socket.ts";
import type { LineGrant } from "./mesh-lines.ts";

const root = mkdtempSync(join(tmpdir(), "ls-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let count = 0;
const socketPath = (): string => join(root, `l${count++}.sock`);

interface Client {
  readonly received: string[];
  readonly closed: Promise<void>;
  readonly answered: Promise<void>;
  send(bytes: string | Uint8Array): void;
}

async function connect(path: string): Promise<Client> {
  const received: string[] = [];
  const closed = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  const queue: Uint8Array[] = [];
  const pump = (socket: { write(bytes: Uint8Array): number }): void => {
    for (let head = queue[0]; head !== undefined; head = queue[0]) {
      const written = Math.max(0, socket.write(head));
      if (written < head.byteLength) {
        queue[0] = head.subarray(written);
        return;
      }
      queue.shift();
    }
  };
  const socket = await Bun.connect({
    unix: path,
    socket: {
      drain: pump,
      data: (_socket, data) => {
        received.push(new TextDecoder().decode(data));
        answered.resolve();
      },
      close: () => closed.resolve(),
      error: () => closed.resolve(),
    },
  });
  return {
    received,
    closed: closed.promise,
    answered: answered.promise,
    send: (bytes) => {
      queue.push(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
      pump(socket);
    },
  };
}

function feedLink(): ByteLink & { push(bytes: Uint8Array): void; readonly closes: number[] } {
  const data = new Set<(bytes: Uint8Array) => void>();
  const closes: number[] = [];
  return {
    closes,
    push: (bytes) => data.forEach((listener) => listener(bytes)),
    send: () => undefined,
    onData: (listener) => {
      data.add(listener);
      return () => data.delete(listener);
    },
    onClose: () => () => undefined,
    close: () => void closes.push(1),
  };
}

const never = (): Promise<LineGrant> => Promise.withResolvers<LineGrant>().promise;

describe("line.sock bounds what it holds (section 7.2)", () => {
  test("a request longer than one request line is cut off, and no grant is asked", async () => {
    const asked: string[] = [];
    const path = socketPath();
    const server = await listenLineSocket({ path, grant: (id) => (asked.push(id), never()), log: () => undefined });
    const client = await connect(path);
    client.send("x".repeat(1024));
    await client.closed;
    expect(asked).toEqual([]);
    server.stop();
  });

  test("bytes sent ahead of a pending grant past the early-bytes bound close the bridge", async () => {
    const path = socketPath();
    const server = await listenLineSocket({ path, grant: never, log: () => undefined });
    const client = await connect(path);
    client.send(`{"v":1,"hostId":"b"}\n`);
    client.send(new Uint8Array(MAX_EARLY_BYTES + 1));
    await client.closed;
    server.stop();
  });

  test("a line whose bridge does not keep up is closed instead of queueing without end", async () => {
    const path = socketPath();
    const link = feedLink();
    const server = await listenLineSocket({
      path,
      grant: () => Promise.resolve({ ok: true, link }),
      log: () => undefined,
    });
    const client = await connect(path);
    client.send(`{"v":1,"hostId":"b"}\n`);
    await client.answered;
    expect(client.received.join("")).toBe('{"ok":true}\n');
    const chunk = new Uint8Array(1024 * 1024);
    for (let sent = 0; sent <= MAX_QUEUED_BYTES * 2; sent += chunk.byteLength) link.push(chunk);
    await client.closed;
    expect(link.closes.length).toBeGreaterThan(0);
    server.stop();
  });
});

describe("line.sock belongs to one running host", () => {
  test("a live line.sock is not taken over by a second host on the same state dir", async () => {
    const path = socketPath();
    const first = await listenLineSocket({ path, grant: never, log: () => undefined });
    await expect(listenLineSocket({ path, grant: never, log: () => undefined })).rejects.toThrow(/in use/);
    const client = await connect(path);
    client.send("{}\n");
    await client.closed;
    expect(client.received.join("")).toContain('"code":4400');
    first.stop();
  });

  test("a stale line.sock left by a host that died is replaced", async () => {
    const path = socketPath();
    const script = `Bun.listen({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); console.log("up");`;
    const dead = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe" });
    const reader = dead.stdout.getReader();
    await reader.read();
    dead.kill("SIGKILL");
    await dead.exited;
    expect(existsSync(path)).toBe(true);
    const server = await listenLineSocket({ path, grant: never, log: () => undefined });
    const client = await connect(path);
    client.send("{}\n");
    await client.closed;
    expect(client.received.join("")).toContain('"code":4400');
    server.stop();
  });
});
