import type { ByteLink, HcConnection } from "@doriface/client";
import { CloseCode, type SecureSession } from "@doriface/crypto";
import { expect, test } from "bun:test";
import type { OpenConnection } from "./connect.ts";
import { type ConnectionSettings, DEFAULT_SETTINGS } from "./settings.ts";
import { UnprovenLinks } from "./wake.ts";

Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
const { ConnectionStore } = await import("./store.ts");
Reflect.deleteProperty(globalThis, "localStorage");

const SETTINGS: ConnectionSettings = { ...DEFAULT_SETTINGS, mode: "relay", hostId: "a", hostKey: "ka" };
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A relay session as the store sees it: a connection, and under it a session whose socket the test drops. */
function opened(outcome: "ok" | "revoked" | "offline-then-ok") {
  const closes: ((error?: Error) => void)[] = [];
  const connection = {
    hello: { core: { id: "c0re", name: "studio" } },
    onClose: (listener: (error?: Error) => void) => (closes.push(listener), () => undefined),
    close: () => undefined,
  } as unknown as HcConnection;
  let detached = false;
  let closed = false;
  let onDetached: ((reason: Error) => void) | undefined;
  const calls = { resumes: 0, lost: [] as Error[], allowed: false };
  const secure = {
    get detached() {
      return detached;
    },
    get closed() {
      return closed;
    },
    allowResume: () => void (calls.allowed = true),
    onDetached: (listener: (reason: Error) => void) => {
      onDetached = listener;
      return () => undefined;
    },
    lost: (reason: Error) => {
      calls.lost.push(reason);
      detached = true;
      onDetached?.(reason);
      return true;
    },
    resume: async (socket: ByteLink) => {
      calls.resumes += 1;
      if (outcome === "offline-then-ok" && calls.resumes === 1) {
        socket.close();
        throw Object.assign(new Error("host offline"), { code: CloseCode.HostOffline });
      }
      if (outcome !== "revoked") {
        detached = false;
        return;
      }
      socket.close();
      throw Object.assign(new Error("unknown device"), { code: CloseCode.UnknownDevice });
    },
    abandon: (reason: Error) => {
      closed = true;
      for (const listener of closes) listener(reason);
    },
  } as unknown as SecureSession;
  const open: OpenConnection = {
    connection,
    path: "relay",
    session: {
      secure,
      redial: async () => ({ send() {}, onData: () => () => {}, onClose: () => () => {}, close() {} }),
    },
  };
  return {
    open,
    calls,
    drop: (reason = new Error("socket dropped")) => {
      detached = true;
      onDetached?.(reason);
    },
  };
}

async function openStore(session: ReturnType<typeof opened>, links: UnprovenLinks) {
  const store = new ConnectionStore(
    SETTINGS,
    () => Promise.resolve(session.open),
    () => undefined,
    { links },
  );
  const isOpen = new Promise<void>((resolve) => {
    const off = store.subscribe(() => {
      if (store.state.phase !== "open") return;
      off();
      resolve();
    });
  });
  store.start();
  await isOpen;
  return store;
}

test("a dropped socket keeps the connection open and marks it resuming until the session is carried on", async () => {
  const session = opened("ok");
  const links = new UnprovenLinks();
  const store = await openStore(session, links);
  expect(session.calls.allowed).toBe(true);
  session.drop();
  expect(store.state).toMatchObject({ phase: "open", connection: session.open.connection, resuming: true });
  expect(links.has(session.open.connection)).toBe(true);
  await settle();
  expect(session.calls.resumes).toBe(1);
  expect(store.state).toMatchObject({ phase: "open", connection: session.open.connection, resuming: false });
  expect(links.has(session.open.connection)).toBe(false);
  store.stop();
});

test("a session the host refuses to carry on drops the connection, and the store reconnects with the workspace kept", async () => {
  const session = opened("revoked");
  const store = await openStore(session, new UnprovenLinks());
  session.drop();
  await settle();
  await settle();
  expect(store.state).toMatchObject({ phase: "failed", stale: session.open.connection });
  expect(session.calls.resumes).toBe(1);
  store.stop();
});

test("while the session is being carried on, the open state says why the last dial failed, until the session is back", async () => {
  const session = opened("offline-then-ok");
  const store = await openStore(session, new UnprovenLinks());
  session.drop();
  expect(store.state).toMatchObject({ phase: "open", resuming: true, resumeFailure: undefined });
  await settle();
  expect(store.state).toMatchObject({
    phase: "open",
    resuming: true,
    resumeFailure: { code: CloseCode.HostOffline },
  });
  store.retryNow();
  await settle();
  expect(store.state).toMatchObject({ phase: "open", resuming: false, resumeFailure: undefined });
  store.stop();
});

test("a wake while the session is being carried on dials again instead of probing the dead link", async () => {
  const session = opened("ok");
  const store = await openStore(session, new UnprovenLinks());
  session.drop();
  // The stand-in connection has no `call`: a probe here would throw.
  store.retryNow();
  await settle();
  expect(store.state).toMatchObject({ phase: "open", resuming: false });
  store.stop();
});
