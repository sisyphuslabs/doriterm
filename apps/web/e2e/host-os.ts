import type { Page } from "@playwright/test";
import { E2E_HOST_PORT } from "./config.ts";
import { setCoreDoc } from "./core-doc.ts";

const HOST_INFO_DOC = "doriface-host";
// A host OS, faked without touching the real host's document: this page's reads are pointed at a document of the same
// length that says the chosen OS. The rest of the hc stream passes through as it is.
const FAKED_DOC = `${HOST_INFO_DOC.slice(0, -1)}x`;

/**
 * Makes the host under test report `os`, whatever the machine running the tests is. A spec that asserts a Mac key on
 * a Linux runner needs this: the bar belongs to the host, so the host has to be the one saying "darwin".
 */
export async function fakeHostOs(page: Page, os: "linux" | "darwin"): Promise<void> {
  setCoreDoc(FAKED_DOC, { v: 1, os });
  await page.routeWebSocket(`ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`, (socket) => {
    const host = socket.connectToServer();
    socket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("latin1");
      const read = `"name":"${HOST_INFO_DOC}"`;
      host.send(text.includes(read) ? Buffer.from(text.replace(read, `"name":"${FAKED_DOC}"`), "latin1") : frame);
    });
    host.onMessage((message) => socket.send(message));
  });
}
