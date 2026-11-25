import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import { createRelaySocket, proxyFor } from "./socket.ts";

test("a wss URL takes WSS_PROXY first, then HTTPS_PROXY, then ALL_PROXY, in either case", () => {
  const url = "wss://relay.example/v1/host/h";
  expect(proxyFor(url, { WSS_PROXY: "http://a:1", HTTPS_PROXY: "http://b:2", ALL_PROXY: "http://c:3" })).toBe(
    "http://a:1",
  );
  expect(proxyFor(url, { https_proxy: "http://b:2", ALL_PROXY: "http://c:3" })).toBe("http://b:2");
  expect(proxyFor(url, { all_proxy: "http://c:3" })).toBe("http://c:3");
  expect(proxyFor(url, {})).toBeUndefined();
});

test("a ws URL takes WS_PROXY, then HTTP_PROXY, then ALL_PROXY, and never an https-only proxy", () => {
  const url = "ws://relay.example/v1/host/h";
  expect(proxyFor(url, { WS_PROXY: "http://a:1", HTTP_PROXY: "http://b:2" })).toBe("http://a:1");
  expect(proxyFor(url, { http_proxy: "http://b:2" })).toBe("http://b:2");
  expect(proxyFor(url, { HTTPS_PROXY: "http://b:2" })).toBeUndefined();
});

test.each([
  ["*", true],
  ["relay.example", true],
  [".example", true],
  ["example", true],
  ["relay.example:443", true],
  ["relay.example:8443", false],
  ["other.example, localhost", false],
  ["xample", false],
])("NO_PROXY %p bypasses the proxy: %p", (noProxy, bypass) => {
  const proxy = proxyFor("wss://relay.example/v1", { HTTPS_PROXY: "http://p:1", NO_PROXY: noProxy });
  expect(proxy === undefined).toBe(bypass);
});

let servers: { close(): void }[] = [];
afterEach(() => {
  for (const server of servers) server.close();
  servers = [];
});

test("a socket made with a proxy in the environment reaches the relay only through that proxy's CONNECT tunnel", async () => {
  const relay = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("no", { status: 426 })),
    websocket: {
      open: (ws) => {
        ws.send("hello");
      },
      message: () => {},
    },
  });
  servers.push({ close: () => relay.stop(true) });
  const tunnels: string[] = [];
  const proxy = net.createServer((client) => {
    client.once("data", (head) => {
      const target = head.toString().split("\r\n")[0]?.split(" ")[1] ?? "";
      tunnels.push(target);
      const [host = "", port = "0"] = target.split(":");
      const upstream = net.connect(Number(port), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
    });
  });
  const listening = Promise.withResolvers<void>();
  proxy.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  servers.push(proxy);
  const address = proxy.address();
  const proxyPort = typeof address === "object" && address !== null ? address.port : 0;

  const create = createRelaySocket({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}` });
  const ws = create(`ws://127.0.0.1:${relay.port}/v1/host/h`);
  const greeting = Promise.withResolvers<string>();
  ws.addEventListener("message", (event) => greeting.resolve(String(event.data)));
  ws.addEventListener("close", (event) => greeting.reject(new Error(`closed ${event.code}`)));
  expect(await greeting.promise).toBe("hello");
  ws.close();
  expect(tunnels).toEqual([`127.0.0.1:${relay.port}`]);
});
