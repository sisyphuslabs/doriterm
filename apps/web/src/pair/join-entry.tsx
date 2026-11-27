import { Button } from "@doriface/ui";
import { useState } from "react";
import { useConnection } from "../connection/store.ts";
import { isIos, runsInstalled } from "../device/install.ts";
import { ConnectDeviceSheet } from "../workspace/connect-device-dialog.tsx";
import type { PairingOffer } from "./fragment.ts";
import { InviteField } from "./invite-field.tsx";

/** The same entry point for a fresh tab and a separate, empty iOS home-screen storage partition. */
export function JoinEntry({ onOffer }: { readonly onOffer: (offer: PairingOffer) => void }) {
  const connection = useConnection();
  const [connecting, setConnecting] = useState(false);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-5 px-4 py-10 md:px-6">
      <h1 className="text-2xl font-semibold text-balance">Join a mesh</h1>
      <p className="max-w-measure text-base text-muted-foreground">
        Open an invite from a machine you can see, or ask a member for one by a call or in person.
      </p>
      {runsInstalled() && connection.phase === "unconfigured" ? (
        <p className="max-w-measure text-prose text-muted-foreground">
          This app has its own storage, so it starts as a device of its own and is not paired with anything yet.
          {isIos()
            ? " An app added to the Home Screen keeps separate storage from the Safari tab you installed it from, which is why it asks again."
            : " An installed app keeps separate storage from the tab you installed it from, which is why it asks again."}{" "}
          {isIos()
            ? "If this app was paired before, iOS cleared its data (it can do that to a Home Screen app's storage), so it needs pairing once more; your machines and their terminals are untouched."
            : "If this app was paired before, the browser cleared its data, so it needs pairing once more."}{" "}
          Opening or pasting an invite below pairs it in place.
        </p>
      ) : null}
      {connection.phase === "open" ? (
        <>
          <Button size="lg" onClick={() => setConnecting(true)}>
            Connect a device
          </Button>
          {connecting ? (
            <ConnectDeviceSheet connection={connection.connection} onClose={() => setConnecting(false)} />
          ) : null}
          <h2 className="border-t border-border pt-4 font-semibold text-foreground">
            Have an invite from another machine?
          </h2>
        </>
      ) : null}
      <InviteField onOffer={onOffer} />
      {connection.phase === "open" ? null : (
        <Button size="lg" render={<a href="/settings#connect" />}>
          From a terminal
        </Button>
      )}
    </main>
  );
}
