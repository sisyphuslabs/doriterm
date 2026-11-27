import { base64urlEncode } from "@doriface/crypto";
import { parseReadmit, readmitApprovalMessage, readmitCode, type ReadmitSubject, verifyReadmit } from "@doriface/mesh";
import { Button, Notice } from "@doriface/ui";
import { useEffect, useState } from "react";
import { loadBrowserIdentity } from "../mesh/identity.ts";
import { slotKeys } from "../mesh/identity-slots.ts";
import { inViewSlot, membershipBundle, useBrowserMembership } from "../mesh/membership-state.ts";
import { deviceStore } from "../storage/idb.ts";
import type { RestoreHolder } from "./blobs.ts";
import { restoreOwner } from "./transport.ts";

interface Prompt {
  readonly holder: RestoreHolder;
  readonly relayUrl: string;
  readonly proof: ReadmitSubject;
}

export function RestoreMemberNotices() {
  const mesh = useBrowserMembership();
  const slot = inViewSlot();
  const [prompt, setPrompt] = useState<Prompt>();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [ignored, setIgnored] = useState<string>();
  const [dismissed, dismiss] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (mesh.phase !== "joined") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const state = await membershipBundle(slot)?.read();
        if (state === undefined || state.relayUrl === "") return;
        const identity = await loadBrowserIdentity(slotKeys(deviceStore, slot));
        const replies = await Promise.allSettled(
          mesh.machines.map(async (holder) => {
            const pending = await restoreOwner(state.relayUrl, holder, identity, { t: "pending" });
            if (!Array.isArray(pending)) return [];
            return pending.flatMap((raw: unknown) => {
              const proof = parseReadmit(raw);
              return proof === undefined || proof.newSig === ignored || !verifyReadmit(mesh.mesh, proof)
                ? []
                : [{ holder, proof, relayUrl: state.relayUrl }];
            });
          }),
        );
        if (live) setPrompt(replies.flatMap((reply) => (reply.status === "fulfilled" ? reply.value : []))[0]);
      } finally {
        if (live) timer = setTimeout(() => void read().catch(() => undefined), 15_000);
      }
    };
    void read().catch(() => undefined);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [mesh, slot, ignored]);
  if (mesh.phase !== "joined" || mesh.self === undefined) return null;
  const self = mesh.self.signPub;
  const readmission = mesh.readmissions?.find((entry) => entry.signPub !== self && !dismissed.has(entry.newSig));
  const answer = async (approve: boolean) => {
    if (prompt === undefined) return;
    const { holder, relayUrl, proof } = prompt;
    if (approve && code !== readmitCode(mesh.mesh, proof)) return;
    setBusy(true);
    setError(undefined);
    try {
      const identity = await loadBrowserIdentity(slotKeys(deviceStore, slot));
      const approval = approve
        ? { by: self, sig: base64urlEncode(await identity.card.sign(readmitApprovalMessage(mesh.mesh, proof))) }
        : null;
      if ((await restoreOwner(relayUrl, holder, identity, { t: "answer", proof, approval })) !== true)
        throw new Error("The machine no longer has this restore request.");
      setIgnored(proof.newSig);
      setPrompt(undefined);
      setCode("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The machine did not accept the answer.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {readmission === undefined ? null : (
        <Notice title={`${readmission.name} was restored on a new device`}>
          Readmitted at{" "}
          <time dateTime={new Date(readmission.at).toISOString()}>{new Date(readmission.at).toLocaleString()}</time>.
          <Button variant="ghost" onClick={() => dismiss(new Set([...dismissed, readmission.newSig]))}>
            Dismiss
          </Button>
        </Notice>
      )}
      {prompt === undefined ? null : (
        <Notice title={`Allow ${prompt.proof.name} to restore on a new device?`}>
          <p>Ask for the code shown on the new device to confirm that this is the request you expect.</p>
          <label>
            Restore comparison code
            <input
              className="ml-2 rounded border p-1"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
            />
          </label>
          <div className="flex gap-2">
            <Button disabled={busy || code !== readmitCode(mesh.mesh, prompt.proof)} onClick={() => void answer(true)}>
              Allow restore
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void answer(false)}>
              Deny restore
            </Button>
          </div>
          {error === undefined ? null : <p role="status">{error}</p>}
        </Notice>
      )}
    </>
  );
}
