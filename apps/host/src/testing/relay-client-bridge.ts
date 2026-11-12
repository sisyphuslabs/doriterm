import type { Server } from "bun";
import type { FakeRelay } from "./fake-relay.ts";

interface Client {
  readonly hostId: string;
  readonly pairSlot: string | undefined;
  send?: (bytes: Uint8Array) => void;
  close?: (code: number) => void;
}

/** The client side of a FakeRelay: each `/v1/client/<hostId>[?pair=<slot>]` socket becomes one session on the uplink. */
export class RelayClientBridge {
  readonly url: string;
  /** The URL of every client socket dialed, in order. */
  readonly dialed: URL[] = [];
  readonly #server: Server<Client>;

  constructor(relay: FakeRelay) {
    this.#server = Bun.serve<Client>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => {
        const url = new URL(request.url);
        this.dialed.push(url);
        const data: Client = {
          hostId: url.pathname.split("/")[3] ?? "",
          pairSlot: url.searchParams.get("pair") ?? undefined,
        };
        return server.upgrade(request, { data }) ? undefined : new Response("upgrade", { status: 426 });
      },
      websocket: {
        open: (ws) => {
          const session = relay.openClient(ws.data.hostId, ws.data.pairSlot);
          session.onData((bytes) => ws.send(bytes));
          void session.closed.then((code) => ws.close(code, ""));
          ws.data.send = (bytes) => session.send(bytes);
          ws.data.close = (code) => session.close(code);
        },
        message: (ws, message) => {
          if (typeof message !== "string") ws.data.send?.(message);
        },
        // The client's own close code reaches the host, as the real relay passes it on: a drop stays a drop there.
        close: (ws, code) => ws.data.close?.(code),
      },
    });
    this.url = `http://127.0.0.1:${this.#server.port ?? 0}`;
  }

  async stop(): Promise<void> {
    await this.#server.stop(true);
  }
}
