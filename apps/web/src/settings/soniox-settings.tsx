import { Badge, Button, Notice, SettingRow } from "@doriface/ui";
import { useState } from "react";
import { type MeshVaultSnapshot, SONIOX_DEFAULTS } from "../vault/mesh-vault.ts";
import { useMeshVault } from "../vault/use-mesh-vault.ts";
import { SonioxKeySheet } from "./soniox-key-sheet.tsx";

function apiKeyDescription(snapshot: MeshVaultSnapshot): string {
  switch (snapshot.phase) {
    case "not-member":
      return "Join this device to your mesh to keep the key in the mesh vault.";
    case "offline":
      return "Connect to one of your machines to open the mesh vault.";
    case "loading":
      return "Opening the mesh vault…";
    case "failed":
      return snapshot.message ?? "Could not open the mesh vault.";
    case "ready":
      switch (snapshot.soniox.kind) {
        case "none":
          return "Not set. Stored encrypted in your mesh vault.";
        case "locked":
          return "In the mesh vault · opens when another device of yours is on";
        case "rolled-back":
          return "This machine handed over an older copy; waiting for a newer one";
        case "saved":
          return snapshot.soniox.openers === 1
            ? "In the mesh vault · 1 device can open it"
            : `In the mesh vault · ${snapshot.soniox.openers} devices can open it`;
      }
  }
}

/** Settings rows for the Soniox speech engine: mesh vault key status, model, and Base URL. Never displays the key. */
export function SonioxSettings() {
  const snapshot = useMeshVault();
  const [sheetOpen, setSheetOpen] = useState(false);

  const saved = snapshot.soniox.kind === "saved" ? snapshot.soniox : null;
  const model = saved === null ? SONIOX_DEFAULTS.model : saved.model;
  const baseUrl = saved === null ? SONIOX_DEFAULTS.baseUrl : saved.baseUrl;

  return (
    <>
      <div className="flex flex-col">
        <SettingRow
          title={
            <span className="inline-flex items-center gap-2">
              <span>API key</span>
              {saved === null ? null : <Badge>E2E</Badge>}
            </span>
          }
          description={apiKeyDescription(snapshot)}
          control={
            <Button disabled={snapshot.phase !== "ready"} onClick={() => setSheetOpen(true)}>
              {saved === null ? "Set key…" : "Replace key…"}
            </Button>
          }
        />
        {saved !== null && saved.replace ? (
          <Notice tone="warning" title="Replace this Soniox key" className="my-2">
            A device that could open this key was removed. Replace the key in the Soniox console, then save the new one
            here.
          </Notice>
        ) : null}
        <SettingRow
          title="Model"
          description={<span className="font-mono [overflow-wrap:anywhere]">{model}</span>}
          control={null}
        />
        <SettingRow
          title="Base URL"
          description={<span className="font-mono [overflow-wrap:anywhere]">{baseUrl}</span>}
          control={null}
        />
      </div>
      <SonioxKeySheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </>
  );
}
