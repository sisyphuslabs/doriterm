import { Button, SettingRow } from "@doriface/ui";
import type { PendingUpdate } from "../update/update-store.ts";

export function UpdateRow({ update }: { readonly update: PendingUpdate }) {
  const restart = update.apply === "restart";
  const title = update.version === undefined ? "A new version is ready" : `Doriterm ${update.version} is ready`;
  return (
    <SettingRow
      inline
      title={title}
      description={restart ? "Doriterm restarts to install it." : "This page reloads to use it."}
      control={
        <Button size="sm" variant="primary" onClick={update.run}>
          {restart ? "Restart to update" : "Reload to update"}
        </Button>
      }
    />
  );
}
