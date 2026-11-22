import { createConnection } from "node:net";

const path = process.env["HC_SOCKET"];
if (!path) throw new Error("the added machine has no HC_SOCKET");

// Like hc connect, carry the protocol over stdio, but never start a core if the socket is gone.
const socket = createConnection(path);
socket.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
socket.on("close", () => process.stdin.pause());
process.stdout.on("error", (error) => socket.destroy(error));
process.stdin.pipe(socket);
socket.pipe(process.stdout);
