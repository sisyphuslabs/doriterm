import { base64urlEncode } from "@doriface/crypto";
import { checkName } from "@doriface/mesh";
import { Button, Field, Input, Notice } from "@doriface/ui";
import { useState } from "react";
import { isIos, runsInstalled } from "../device/install.ts";
import { deviceName } from "./device-name.ts";
import type { PairingOffer } from "./fragment.ts";
import { carryInvite } from "./invite-handoff.ts";
import { useBrowserJoin } from "./use-browser-join.ts";
import { VerifyStep } from "./verify-step.tsx";
import { meshNameOf } from "../mesh/member-name.ts";

/** A browser joins with its own card, and only its person's answer confirms the shared join ceremony. */
export function MeshInvite({ offer }: { readonly offer?: PairingOffer }) {
  const flow = useBrowserJoin();
  const installed = runsInstalled();
  const [name, setName] = useState(() => meshNameOf(`${deviceName()}${installed ? "-app" : ""}`));
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  const state = flow.state;
  // A typed code from `doriface-host pair` opens a device pairing: the same code pairs this browser with that host.
  if (flow.device !== undefined) return <VerifyStep offer={flow.device} />;
  const transfer = async (): Promise<void> => {
    if (offer?.secret.mode !== "link") return;
    try {
      const params = new URLSearchParams({
        h: offer.hostId,
        k: base64urlEncode(offer.noiseStaticPub),
        s: base64urlEncode(offer.signPub),
        p: base64urlEncode(offer.secret.linkSecret),
        r: offer.relayUrl,
        m: "1",
      });
      await carryInvite(`${location.origin}/pair#${params}`);
      setCopied(true);
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-5 px-6 py-10">
      {state?.phase === "comparing" || state?.phase === "waiting" ? (
        <>
          <h1 className="text-2xl font-semibold text-balance">
            {state.phase === "comparing"
              ? `Does ${flow.inviter} show this code?`
              : `Waiting for approval on ${flow.inviter}`}
          </h1>
          <p aria-label="Join code" className="text-center text-4xl font-semibold tracking-widest tabular-nums">
            {state.code}
          </p>
          <p className="text-base text-muted-foreground">
            {`Look at ${flow.inviter}'s screen, or ask the person who sent the invite by a call or in person, not in the chat that carried the link. If it shows no code or another one, the invite is not from your mesh.`}
          </p>
          {installed && isIos() ? (
            <p className="text-sm text-muted-foreground">Switch to Safari to approve, then come back.</p>
          ) : null}
          {state.phase === "comparing" ? (
            <div className="flex flex-col gap-2">
              <Button variant="primary" size="lg" onClick={() => flow.answer(true)}>
                The codes match
              </Button>
              <Button size="lg" onClick={() => flow.answer(false)}>
                The codes differ
              </Button>
            </div>
          ) : null}
        </>
      ) : state?.phase === "mismatch" ? (
        <Notice title="Not joined" tone="warning">
          This invite may not come from your mesh. Ask for a new one from a machine you can see. No bundle and no
          membership were stored.
        </Notice>
      ) : state?.phase === "refused" || flow.failure !== undefined ? (
        <>
          <Notice title="Not joined" tone="error">
            {state?.phase === "refused" ? state.reason : flow.failure} This invite did not add a membership.
          </Notice>
          <Button render={<a href="/join" />}>Join again</Button>
        </>
      ) : state?.phase === "interrupted" ? (
        <Notice title="Resuming this join">
          The session dropped. This browser will continue the same invite and show the same code.
        </Notice>
      ) : (
        <>
          <h1 className="text-2xl font-semibold text-balance">Join this mesh</h1>
          <p className="text-base text-muted-foreground">
            This browser becomes a member and reaches every machine in the mesh.
          </p>
          <Field
            label="This browser's name"
            htmlFor="mesh-member-name"
            hint="Lowercase letters, digits, dots, underscores and hyphens"
          >
            <Input id="mesh-member-name" value={name} onValueChange={setName} maxLength={32} />
          </Field>
          {offer?.secret.mode === "link" && isIos() && !installed ? (
            <Button onClick={() => void transfer()}>Join in the home-screen app</Button>
          ) : null}
          {copied ? (
            <Notice title="Invite copied">
              In Safari, tap Share, then Add to Home Screen. Open the app and tap Paste invite. No card was sent.
            </Notice>
          ) : null}
          {copyError === undefined ? null : (
            <Notice title="Could not copy" tone="error">
              {copyError}
            </Notice>
          )}
          <Button
            variant="primary"
            size="lg"
            loading={flow.busy}
            disabled={offer === undefined || !checkName(name)}
            onClick={() => void flow.start(offer, name)}
          >
            Join
          </Button>
          <details className="text-sm text-muted-foreground">
            <summary>I meant to add a computer</summary>
            <p className="my-3">
              On that computer, run this with the invite, then compare the join code on both screens.
            </p>
            <code className="block rounded-md bg-raised p-3 text-foreground">doriface-host mesh join &lt;link&gt;</code>
          </details>
        </>
      )}
      {state?.phase === "mismatch" ? (
        <>
          <Button render={<a href="/join" />}>Ask for a new invite</Button>
        </>
      ) : null}
    </main>
  );
}
