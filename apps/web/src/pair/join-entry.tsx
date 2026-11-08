import { Button, Field, Input, Notice } from "@doriface/ui";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { connectionStore } from "../connection/store.ts";
import { normalizeCode } from "./code.ts";
import { parsePairingFragment, type PairingOffer } from "./fragment.ts";
import { pasteInvite } from "./invite-handoff.ts";
import { SlotLookups } from "./slot-lookups.ts";
import { useOnline } from "../pwa/use-online.ts";
import { ScanButton } from "./scan-button.tsx";
import { offerFromScan } from "./scan.ts";
import { pairingLink } from "./link-capture.ts";

/** The same entry point for a fresh tab and a separate, empty iOS home-screen storage partition. */
export function JoinEntry({ onOffer }: { readonly onOffer: (offer: PairingOffer) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [lookups] = useState(() => new SlotLookups(connectionStore.settings.relayUrl));
  const online = useOnline();
  const navigate = useNavigate();
  const showOffer = (candidate: string, offer: PairingOffer): void => {
    if (offer.target === "mesh") {
      onOffer(offer);
      return;
    }
    pairingLink.set(candidate.slice(candidate.indexOf("#")));
    void navigate({ to: "/pair" });
  };
  const apply = async (candidate: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const hash = candidate.indexOf("#");
      const code = normalizeCode(candidate);
      if (hash === -1 && code === null) throw new Error("Paste an invite link or enter its 8-character code.");
      const parsed = hash >= 0 ? parsePairingFragment(candidate.slice(hash)) : await lookups.offer(code ?? "");
      if (!parsed.ok) throw new Error(parsed.reason);
      showOffer(candidate, hash < 0 ? { ...parsed.offer, target: "mesh" } : parsed.offer);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-5 px-6 py-10">
      <h1 className="text-2xl font-semibold text-balance">Join a mesh</h1>
      <p className="text-base text-muted-foreground">
        Open an invite from a machine you can see, or ask a member for one by a call or in person.
      </p>
      {!online ? (
        <Notice title="You are offline" tone="warning">
          <span id="join-needs-network">Joining a mesh needs a network. Reconnect, then open or paste an invite.</span>
        </Notice>
      ) : null}
      <Button
        size="lg"
        disabled={!online}
        aria-describedby={online ? undefined : "join-needs-network"}
        onClick={() =>
          void pasteInvite().then(apply, (cause: unknown) =>
            setError(cause instanceof Error ? cause.message : String(cause)),
          )
        }
      >
        Paste invite
      </Button>
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void apply(text);
        }}
      >
        <Field label="Invite link or code" htmlFor="mesh-invite" error={error}>
          <Input
            id="mesh-invite"
            className="min-h-11"
            value={text}
            onValueChange={(value) => {
              setText(value);
              setError(undefined);
              if (online && !value.includes("#")) lookups.typed(value);
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Button
          type="submit"
          size="lg"
          variant="primary"
          loading={busy}
          disabled={!online || text.trim() === ""}
          aria-describedby={online ? undefined : "join-needs-network"}
        >
          Continue
        </Button>
      </form>
      <ScanButton
        onText={(value) => {
          const parsed = offerFromScan(value);
          setError(parsed.ok ? undefined : parsed.reason);
          if (parsed.ok) showOffer(value, parsed.offer);
        }}
      />
      <Button size="lg" render={<a href="/settings#connect" />}>
        Connect a machine
      </Button>
    </main>
  );
}
