import { Button, SettingRow } from "@doriface/ui";
import { useEffect, useState } from "react";
import { loadBrowserIdentity } from "../mesh/identity.ts";
import { slotKeys } from "../mesh/identity-slots.ts";
import { inViewSlot, membershipBundle, useBrowserMembership } from "../mesh/membership-state.ts";
import { deviceStore } from "../storage/idb.ts";
import { enrollRestore, removeRestore } from "./enrollment.ts";
import { browserPasskey, rawCardForEnrollment } from "./passkey.ts";

export function RestoreSetting() {
  const mesh = useBrowserMembership();
  const slot = inViewSlot();
  const [status, setStatus] = useState<"unsupported" | "off" | "on">("unsupported");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const flag = `restore-enabled:${slot}`;

  useEffect(() => {
    let active = true;
    const storage = slotKeys(deviceStore, slot);
    if (mesh.phase === "joined" && browserPasskey() !== undefined)
      void Promise.all([storage.get("device-key"), storage.get("mesh-sign-key"), deviceStore.get(flag)]).then(
        ([device, card, enabled]) => {
          const raw = rawCardForEnrollment(navigator.userAgent, device, card);
          if (active) setStatus(raw === undefined ? "unsupported" : enabled === true ? "on" : "off");
          raw?.fill(0);
          return undefined;
        },
        () => {
          if (active) setStatus("unsupported");
        },
      );
    return () => {
      active = false;
    };
  }, [flag, mesh.phase, slot]);

  if (mesh.phase !== "joined" || status === "unsupported") return null;

  const run = async () => {
    const passkey = browserPasskey();
    if (passkey === undefined) return;
    setBusy(true);
    setMessage(undefined);
    const storage = slotKeys(deviceStore, slot);
    try {
      const retained = await membershipBundle(slot)?.read();
      if (retained === undefined) throw new Error("This browser has no current mesh membership.");
      const target = { relayUrl: retained.relayUrl, meshId: mesh.mesh, holders: mesh.machines.slice(0, 8) };
      const identity = await loadBrowserIdentity(storage);
      if (status === "on") {
        await removeRestore(target, identity);
        await deviceStore.put(flag, false);
        setStatus("off");
      } else {
        const raw = rawCardForEnrollment(
          navigator.userAgent,
          await storage.get("device-key"),
          await storage.get("mesh-sign-key"),
        );
        if (raw === undefined) throw new Error("This browser cannot enroll its current keys.");
        try {
          await enrollRestore(passkey, target, identity, raw);
          await deviceStore.put(flag, true);
          setStatus("on");
        } finally {
          raw.fill(0);
        }
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Passkey restore could not be changed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingRow
        title="Passkey restore"
        description={
          status === "on"
            ? "On. This app can ask to rejoin the mesh if its storage is cleared."
            : "Off. Set it up so this app can ask to rejoin the mesh if its storage is cleared."
        }
        control={
          <Button disabled={busy} variant="secondary" onClick={() => void run()}>
            {status === "on" ? "Remove restore key" : "Set up passkey restore"}
          </Button>
        }
      />
      {message === undefined ? null : <p role="status">{message}</p>}
    </>
  );
}
