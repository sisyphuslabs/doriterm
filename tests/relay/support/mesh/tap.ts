import type { Socket } from "bun";
import { CloseFrameReader } from "./close-frames.ts";

const CRLF = "\r\n";
/** The relay's client dial: `GET /v1/client/<hostId>?…` (the target host is in the request line). */
const CLIENT_DIAL = /^GET \/v1\/client\/([a-z2-7]+)[?\s]/;
/** The host's own uplink: `GET /v1/host/<hostId>?…`. */
const HOST_UPLINK = /^GET \/v1\/host\/[a-z2-7]+[?\s]/;
const UPGRADED = "HTTP/1.1 101 ";

/** One host's door to the relay: a TCP forwarder that names the host's source IP and can be cut and healed. */
export interface Tap {
  /** What the host is given as `--relay`. Its port is part of the origin the host signs over. */
  readonly url: string;
  readonly port: number;
  /** The source IP this tap sets; undefined on a transparent front that preserves the caller's header. */
  readonly ip: string | undefined;
  /** Bytes forwarded in both directions. */
  bytes(): number;
  /** Connections currently open through the tap. */
  open(): number;
  /** Connections currently open through the tap that are this host's dials to `hostId`. */
  openTo(hostId: string): number;
  /** Every host this host dialed through the tap (sync sessions and hc lines alike), refused dials included. */
  dials(): readonly string[];
  /** Every WebSocket close code the relay sent this host, on its uplink and its dials alike, in arrival order. */
  closeCodes(): readonly number[];
  /**
   * Every upgraded uplink (`/v1/host/…`) through this tap that has ended, in order: the last close code the relay sent
   * on it, or null when it ended with no close frame. Either form is one disconnect.
   */
  uplinkEnds(): readonly (number | null)[];
  /** Calls `wake` whenever a connection opens or closes, until the returned function is called. */
  onChange(wake: () => void): () => void;
  /** Closes every connection and refuses new ones, as a network partition from this host's side. */
  cut(): void;
  /** Refuses (and closes) this host's dials to these hosts only: a partition between groups, uplinks kept. */
  block(hostIds: readonly string[]): void;
  /** Ends `cut` and `block`. */
  heal(): void;
  stop(): void;
}

interface Conn {
  up: Socket<undefined> | undefined;
  head: string;
  headDone: boolean;
  target: string | undefined;
  uplink: boolean;
  /** The relay's bytes up to the end of its status line. */
  status: string;
  queue: Uint8Array[];
  closes: CloseFrameReader;
}

export function makeTap(upstreamPort: number | (() => number), ip?: string): Tap {
  const conns = new Set<Socket<Conn>>();
  const wakes = new Set<() => void>();
  const changed = (): void => {
    for (const wake of wakes) wake();
  };
  const dialed: string[] = [];
  /** One list for every connection, so a phase can mark it by length and read only what arrived later. */
  const closeCodes: number[] = [];
  const uplinkEnds: (number | null)[] = [];
  let forwarded = 0;
  let cut = false;
  let blocked = new Set<string>();
  const refused = (conn: Conn): boolean => cut || (conn.target !== undefined && blocked.has(conn.target));
  const forward = (conn: Conn, bytes: Uint8Array): void => {
    forwarded += bytes.length;
    if (conn.up === undefined) conn.queue.push(bytes);
    else conn.up.write(bytes);
  };
  const listener = Bun.listen<Conn>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        if (cut) return void socket.end();
        const conn: Conn = {
          up: undefined,
          head: "",
          headDone: false,
          target: undefined,
          uplink: false,
          status: "",
          queue: [],
          closes: new CloseFrameReader(),
        };
        socket.data = conn;
        conns.add(socket);
        changed();
        void Bun.connect({
          hostname: "127.0.0.1",
          port: typeof upstreamPort === "number" ? upstreamPort : upstreamPort(),
          socket: {
            data(_up, bytes) {
              forwarded += bytes.length;
              if (!conn.status.includes(CRLF)) conn.status += Buffer.from(bytes).toString("latin1");
              const seen = conn.closes.codes.length;
              conn.closes.feed(bytes);
              closeCodes.push(...conn.closes.codes.slice(seen));
              socket.write(bytes);
            },
            close: () => void socket.end(),
            error: () => void socket.end(),
          },
        }).then(
          (up) => {
            conn.up = up;
            for (const queued of conn.queue.splice(0)) up.write(queued);
            if (cut) up.end();
            return undefined;
          },
          () => socket.end(),
        );
      },
      data(socket, bytes) {
        const conn = socket.data;
        if (conn.headDone) return forward(conn, bytes);
        // The IP header goes in right after the request line, before the first header.
        conn.head += Buffer.from(bytes).toString("latin1");
        const end = conn.head.indexOf(CRLF);
        if (end < 0) return;
        conn.headDone = true;
        const line = conn.head.slice(0, end + CRLF.length);
        conn.target = CLIENT_DIAL.exec(line)?.[1];
        conn.uplink = HOST_UPLINK.test(line);
        if (conn.target !== undefined) dialed.push(conn.target);
        if (refused(conn)) return void socket.end();
        const source = ip === undefined ? "" : `cf-connecting-ip: ${ip}${CRLF}`;
        forward(conn, Buffer.from(`${line}${source}${conn.head.slice(line.length)}`, "latin1"));
        conn.head = "";
      },
      close(socket) {
        conns.delete(socket);
        const conn = socket.data;
        conn.up?.end();
        if (conn.uplink && conn.status.startsWith(UPGRADED)) uplinkEnds.push(conn.closes.codes.at(-1) ?? null);
        changed();
      },
      error: (socket) => void socket.end(),
    },
  });
  const endRefused = (): void => {
    for (const socket of conns) if (refused(socket.data)) socket.end();
  };
  return {
    url: `http://127.0.0.1:${listener.port}`,
    port: listener.port,
    ip,
    bytes: () => forwarded,
    open: () => conns.size,
    openTo: (hostId) => [...conns].filter((socket) => socket.data.target === hostId).length,
    dials: () => dialed,
    closeCodes: () => closeCodes,
    uplinkEnds: () => uplinkEnds,
    onChange(wake) {
      wakes.add(wake);
      return () => wakes.delete(wake);
    },
    cut() {
      cut = true;
      endRefused();
    },
    block(hostIds) {
      blocked = new Set(hostIds);
      endRefused();
    },
    heal() {
      cut = false;
      blocked = new Set();
    },
    stop() {
      cut = true;
      endRefused();
      listener.stop(true);
    },
  };
}
