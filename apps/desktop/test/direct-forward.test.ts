import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { DirectForwarder } from "../src/main/direct-forward.ts";

const APP = "app://doriface";

/** The port a listener bound: it asked for 0, so this is the one the OS gave it. */
function portOf(server: { address(): unknown }): number {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? Reflect.get(address, "port") : undefined;
  if (typeof port !== "number") throw new Error("the peer named no port");
  return port;
}

/** A host on this machine: it echoes each binary frame back, answers `ping` with `pong`, and counts its sessions. */
interface Peer {
  readonly url: string;
  readonly connections: () => number;
  readonly stop: () => Promise<void>;
}

async function echoingPeer(): Promise<Peer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  let admitted = 0;
  server.on("connection", (socket) => {
    admitted += 1;
    socket.on("message", (data: Buffer, binary: boolean) => {
      if (binary) socket.send(data, { binary: true });
      else if (String(data) === "ping") socket.send("pong");
    });
  });
  return {
    url: `ws://127.0.0.1:${portOf(server)}/v1/e2ee`,
    connections: () => admitted,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A host that answers the upgrade with a redirect, as a proxy in front of the LAN listener could. */
async function redirectingPeer(): Promise<Peer> {
  let admitted = 0;
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.on("upgrade", (_request, socket) => {
    socket.write("HTTP/1.1 302 Found\r\nlocation: ws://127.0.0.1:9/elsewhere\r\ncontent-length: 0\r\n\r\n");
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    url: `ws://127.0.0.1:${portOf(server)}/v1/e2ee`,
    connections: () => admitted,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The page's side: a socket to the forwarder, with the app's origin and the capability the shell issued. */
function pageSocket(url: string, origin = APP): WebSocket {
  return new WebSocket(url, { origin });
}

const opened = (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error) => reject(error));
  });

const answered = (socket: WebSocket): Promise<Uint8Array> =>
  new Promise((resolve) => socket.once("message", (data: Buffer) => resolve(new Uint8Array(data))));

const refused = (socket: WebSocket): Promise<number> =>
  new Promise((resolve) =>
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0)),
  );

const closed = (socket: WebSocket): Promise<void> => new Promise((resolve) => socket.once("close", () => resolve()));

const live: DirectForwarder[] = [];
afterEach(async () => {
  const stopping = live.splice(0).map((forwarder) => forwarder.stop());
  await Promise.all(stopping);
});

function forwarderFor(origin = APP): DirectForwarder {
  const forwarder = new DirectForwarder({ origin });
  live.push(forwarder);
  return forwarder;
}

test("a capability carries bytes both ways to the configured address, and the page never dials it", async () => {
  const peer = await echoingPeer();
  const forwarder = forwarderFor();
  expect(forwarder.setTarget("ws://192.0.2.10:7767/v1/hc")).toBe(false);
  expect(forwarder.setTarget(peer.url)).toBe(true);
  const answer = await forwarder.issue(7);
  if (!("url" in answer)) throw new Error(`expected a forward, got ${answer.refused}`);
  const socket = pageSocket(answer.url);
  await opened(socket);
  const reply = answered(socket);
  socket.send(new Uint8Array([1, 2, 3]));
  expect(Array.from(await reply)).toEqual([1, 2, 3]);
  expect(peer.connections()).toBe(1);
  socket.close();
  await peer.stop();
});

test("a capability is bound to the app origin and to one use", async () => {
  const peer = await echoingPeer();
  const forwarder = forwarderFor();
  forwarder.setTarget(peer.url);
  const answer = await forwarder.issue(7);
  if (!("url" in answer)) throw new Error("no forward");
  const foreign = pageSocket(answer.url, "app://other");
  expect(await refused(foreign)).toBe(403);
  const used = pageSocket(answer.url);
  await opened(used);
  used.close();
  await closed(used);
  const again = pageSocket(answer.url);
  expect(await refused(again)).toBe(403);
  expect(peer.connections()).toBe(1);
  await peer.stop();
});

test("a window that went away keeps no capability, and its forward is closed", async () => {
  const peer = await echoingPeer();
  const forwarder = forwarderFor();
  forwarder.setTarget(peer.url);
  const answer = await forwarder.issue(7);
  if (!("url" in answer)) throw new Error("no forward");
  const socket = pageSocket(answer.url);
  await opened(socket);
  forwarder.dropWindow(7);
  await closed(socket);
  const later = pageSocket(answer.url);
  expect(await refused(later)).toBe(403);
  await peer.stop();
});

test("a cancelled capability opens nothing", async () => {
  const peer = await echoingPeer();
  const forwarder = forwarderFor();
  forwarder.setTarget(peer.url);
  const answer = await forwarder.issue(7);
  if (!("url" in answer)) throw new Error("no forward");
  expect(forwarder.cancel(answer.url)).toBe(true);
  expect(await refused(pageSocket(answer.url))).toBe(403);
  expect(peer.connections()).toBe(0);
  await peer.stop();
});

test("a redirect is refused: the forward never follows it", async () => {
  const peer = await redirectingPeer();
  const forwarder = forwarderFor();
  forwarder.setTarget(peer.url);
  const answer = await forwarder.issue(7);
  if (!("url" in answer)) throw new Error("no forward");
  const socket = pageSocket(answer.url);
  await opened(socket);
  await closed(socket);
  expect(peer.connections()).toBe(0);
  await peer.stop();
});

test("the keepalive crosses the forward: the page's ping reaches the host, its pong comes back, and bytes still flow (#1040)", async () => {
  const peer = await echoingPeer();
  const forwarder = forwarderFor();
  forwarder.setTarget(peer.url);
  const answer = await forwarder.issue(7);
  if (!("url" in answer)) throw new Error("no forward");
  const socket = pageSocket(answer.url);
  await opened(socket);
  const pong = new Promise<string>((resolve) =>
    socket.once("message", (data: Buffer, binary: boolean) => resolve(`${binary ? "binary" : "text"} ${String(data)}`)),
  );
  const ended = closed(socket).then(() => "closed");
  socket.send("ping");
  expect(await Promise.race([pong, ended])).toBe("text pong");
  const reply = answered(socket);
  socket.send(new Uint8Array([4, 5]));
  expect(Array.from(await reply)).toEqual([4, 5]);
  socket.close();
  await peer.stop();
});

test("any other text frame closes the forward", async () => {
  const peer = await echoingPeer();
  const forwarder = forwarderFor();
  forwarder.setTarget(peer.url);
  const answer = await forwarder.issue(7);
  if (!("url" in answer)) throw new Error("no forward");
  const socket = pageSocket(answer.url);
  await opened(socket);
  const ended = closed(socket);
  socket.send("hello");
  await ended;
  await peer.stop();
});

test("every member is forwarded to its own address at once, and one member's forward leaves another's open (#1499)", async () => {
  const first = await echoingPeer();
  const second = await echoingPeer();
  const forwarder = forwarderFor();
  // Both members ask before either dials: each capability is bound to the address named with it.
  const [one, two] = await Promise.all([forwarder.issue(7, first.url), forwarder.issue(7, second.url)]);
  if (!("url" in one) || !("url" in two)) throw new Error("expected a forward for each member");
  const a = pageSocket(one.url);
  await opened(a);
  const b = pageSocket(two.url);
  await opened(b);
  expect([first.connections(), second.connections()]).toEqual([1, 1]);
  // The first member's session is still carried after the second member's forward opened.
  const reply = answered(a);
  a.send(new Uint8Array([4, 5, 6]));
  expect(Array.from(await reply)).toEqual([4, 5, 6]);
  a.close();
  b.close();
  await first.stop();
  await second.stop();
});

test("with no usable address set, a capability is refused with its reason and no socket opens", async () => {
  const forwarder = forwarderFor();
  expect(forwarder.setTarget("ws://192.0.2.10:7767/v1/hc")).toBe(false);
  expect(await forwarder.issue(7)).toEqual({ refused: "no direct address to forward to" });
});
