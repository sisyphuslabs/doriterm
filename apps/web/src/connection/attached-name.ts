import type { HcConnection } from "@doriface/client";
import { attachedMachineName } from "./hello-name.ts";
import { connectionStore } from "./store.ts";

/**
 * The name to show for the machine this client's core is attached to: its mesh member name on a joined browser, the name
 * its core answered with anywhere else (#1902). Every label for that machine reads it, so one machine has one name.
 */
export const machineName = (connection: HcConnection): string =>
  attachedMachineName(connection, connectionStore.settings, connectionStore.selected?.settings.hostId);
