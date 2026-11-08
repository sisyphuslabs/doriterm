import { base64urlEncode, closeCodeOf, PAIRING_TTL_MS } from "@doriface/crypto";
import { JOINER_EXPECTS, MeshLines } from "@doriface/mesh/join";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { loadBrowserIdentity } from "../mesh/identity.ts";
import { connectionStore } from "../connection/store.ts";
import { prepareMembership } from "../mesh/membership-state.ts";
import { deviceStore } from "../storage/idb.ts";
import { BrowserJoin } from "../mesh/join-state.ts";
import type { PairingOffer } from "./fragment.ts";
import { JOIN_ANCHOR_KEY, loadJoinAnchor, type BrowserJoinAnchor } from "./join-anchor.ts";
import { openBrowserJoin, openBrowserResume, refuseEarly, BROWSER_JOIN_DEPS } from "../mesh/join.ts";
import { guideStore } from "./first-run-guide.ts";

const subscribeEmpty = () => () => undefined;
const empty = () => undefined;

/** Owns sockets across UI renders. A reload resumes an anchor; it never repeats a card on a spent invitation. */
export function useBrowserJoin() {
  const [flow, setFlow] = useState<BrowserJoin>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [inviter, setInviter] = useState("the inviting machine");
  const active = useRef<BrowserJoin | undefined>(undefined);
  const generation = useRef(0);
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const state = useSyncExternalStore(flow?.subscribe ?? subscribeEmpty, flow?.snapshot ?? empty);
  const execute = useCallback(
    async (offer: PairingOffer | undefined, name: string, resume?: BrowserJoinAnchor): Promise<void> => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setFailure(undefined);
      const run = ++generation.current;
      try {
        if (offer !== undefined) await refuseEarly(offer, BROWSER_JOIN_DEPS.membership);
        const bundle = await prepareMembership();
        const identity = await loadBrowserIdentity();
        const inviterName =
          resume?.inviterName ??
          connectionStore.entries().find((entry) => entry.target.hostId === offer?.hostId)?.target.hostName ??
          "the inviting machine";
        setInviter(inviterName);
        const session =
          resume !== undefined
            ? await openBrowserResume(resume, identity)
            : offer !== undefined
              ? await openBrowserJoin(offer, identity, name)
              : undefined;
        if (session === undefined) return;
        if (run !== generation.current) {
          session.close();
          return;
        }
        const controller = new BrowserJoin(deviceStore, identity, bundle);
        active.current = controller;
        setFlow(controller);
        if (offer === undefined && resume === undefined) return;
        const context = resume ?? {
          name,
          relayUrl: offer?.relayUrl ?? connectionStore.settings.relayUrl,
          inviterName,
          dialed: { hostId: offer?.hostId ?? "", noisePub: base64urlEncode(offer?.noiseStaticPub ?? new Uint8Array()) },
          expiresAt: Date.now() + PAIRING_TTL_MS,
        };
        await deviceStore.put("mesh.browser-name", context.name);
        await navigator.storage?.persist?.().then(
          () => undefined,
          () => undefined,
        );
        await controller.run(
          { lines: new MeshLines(session, JOINER_EXPECTS), handshakeHash: session.handshakeHash },
          {
            ...context,
            ...(resume === undefined ? {} : { resume }),
          },
        );
        if (controller.snapshot().phase === "joined") {
          guideStore.start();
          connectionStore.edit({ relayUrl: context.relayUrl });
          connectionStore.start();
          window.location.assign("/settings#machines");
        }
      } catch (error) {
        const refused = resume !== undefined && error instanceof Error && closeCodeOf(error) === 4401;
        if (refused) await deviceStore.put(JOIN_ANCHOR_KEY, null);
        if (run === generation.current)
          setFailure(refused ? "Ask for a new invite" : error instanceof Error ? error.message : String(error));
      } finally {
        if (run === generation.current) {
          running.current = false;
          setBusy(false);
        }
      }
    },
    [],
  );
  const resume = useCallback(async (): Promise<void> => {
    try {
      const anchor = await loadJoinAnchor();
      if (anchor !== undefined) await execute(undefined, anchor.name, anchor);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }, [execute]);
  useEffect(() => {
    void resume();
    const wake = () => {
      if (document.visibilityState === "visible" && !running.current) void resume();
    };
    addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      generation.current += 1;
      running.current = false;
      active.current?.stop();
      clearTimeout(timer.current);
      removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [resume]);
  useEffect(() => {
    if (state?.phase !== "interrupted" || busy) return;
    timer.current = setTimeout(() => {
      if (document.visibilityState === "visible") void resume();
    }, 1_000);
    return () => clearTimeout(timer.current);
  }, [state, busy, resume]);
  return { state, failure, busy, inviter, start: execute, answer: (matches: boolean) => flow?.answer(matches), resume };
}
