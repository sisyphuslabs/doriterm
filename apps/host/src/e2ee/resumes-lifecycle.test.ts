import { CloseCode } from "@doriface/crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { bytes, cleanupResumeHosts, dropped, flush, resumeHost, texts } from "../testing/resume-harness.ts";
import { MAX_DETACHED_SESSIONS } from "./resumes.ts";

afterEach(cleanupResumeHosts);

// What a waiting session holds on the host is its `hc connect`: these follow the children themselves through the gateway,
// past the cap and through repeated drops (#2853 review).
describe("the hc connect behind a session that waits for its client", () => {
  test("a drop past the cap ends the longest-waiting session's hc connect, which exits; every other keeps its own", async () => {
    const h = resumeHost();
    const clients = [];
    for (let at = 0; at <= MAX_DETACHED_SESSIONS; at += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sessions open one after another, each with its own hc connect
      const client = await h.connect();
      client.client.send(bytes(`hello ${at}\n`));
      clients.push(client);
    }
    await flush();
    expect(h.children.length).toBe(MAX_DETACHED_SESSIONS + 1);
    for (const { clientEnd, hostEnd } of clients.slice(0, MAX_DETACHED_SESSIONS)) {
      clientEnd.end(dropped());
      hostEnd.end(dropped());
    }
    await flush();
    expect(h.children.filter((child) => child.state.closed)).toEqual([]);

    const last = clients[MAX_DETACHED_SESSIONS];
    last?.clientEnd.end(dropped());
    last?.hostEnd.end(dropped());
    await flush();
    const first = h.children[0];
    expect(first?.state.closed).toBe(true);
    await first?.child.exited;
    expect(h.children.slice(1).filter((child) => child.state.closed)).toEqual([]);

    // The ended session cannot be come back to; its device starts a new one.
    const again = h.redial();
    const refused = await clients[0]?.client.resume(again.clientEnd).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    await again.served;
    expect(again.hostEnd.closeCode).toBe(CloseCode.ResumeRefused);
    expect(h.children.length).toBe(MAX_DETACHED_SESSIONS + 1);

    // The host stopping ends every session still waiting, so no hc connect and no resume timer is left behind.
    await h.gateway.closeAll();
    expect(h.children.filter((child) => !child.state.closed)).toEqual([]);
    await Promise.all(h.children.map((child) => child.child.exited));
  });

  test("a session dropped and resumed five times keeps one hc connect, which exits when the session ends", async () => {
    const h = resumeHost();
    const { client, clientEnd, hostEnd, received } = await h.connect();
    client.send(bytes("0\n"));
    await flush();
    let ends = { clientEnd, hostEnd };
    for (let round = 1; round <= 5; round += 1) {
      ends.clientEnd.end(dropped());
      ends.hostEnd.end(dropped());
      // oxlint-disable-next-line no-await-in-loop -- each drop is seen before the next resume
      await flush();
      const again = h.redial();
      // oxlint-disable-next-line no-await-in-loop -- one resume at a time, as one client makes them
      await client.resume(again.clientEnd);
      // oxlint-disable-next-line no-await-in-loop -- the host binds the new link before the next line
      await again.served;
      client.send(bytes(`${round}\n`));
      // oxlint-disable-next-line no-await-in-loop -- the echo arrives before the next drop
      await flush();
      ends = { clientEnd: again.clientEnd, hostEnd: again.hostEnd };
    }
    expect(texts(received)).toEqual(["0\n", "1\n", "2\n", "3\n", "4\n", "5\n"]);
    expect(h.children.length).toBe(1);
    expect(h.children[0]?.state.closed).toBe(false);

    ends.clientEnd.close();
    await flush();
    expect(h.children[0]?.state.closed).toBe(true);
    await h.children[0]?.child.exited;
  });
});
