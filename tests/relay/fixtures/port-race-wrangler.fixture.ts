#!/usr/bin/env bun
// A local relay process whose explicit ports are taken before it binds, as in #1015.
const argument = (name: string): number => Number(Bun.argv[Bun.argv.indexOf(name) + 1]);
const port = argument("--port");
const inspector = argument("--inspector-port");
const competitors = [port, inspector]
  .filter((value) => value !== 0)
  .map((value) => Bun.listen({ hostname: "127.0.0.1", port: value, socket: { data() {} } }));

try {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      return Response.json({
        host: request.headers.get("host"),
        ip: request.headers.get("cf-connecting-ip"),
      });
    },
  });
  const debug = Bun.listen({ hostname: "127.0.0.1", port: inspector, socket: { data() {} } });
  process.once("SIGTERM", () => {
    debug.stop(true);
    server.stop(true);
    process.exit(0);
  });
  console.log(`Ready on http://127.0.0.1:${server.port}`);
} catch (error) {
  for (const listener of competitors) listener.stop(true);
  console.error(error);
  process.exit(1);
}
