import { generateHostIdentity, type HostIdentity } from "@doriface/crypto";
import { loadHostIdentity } from "../../../../apps/host/src/state/host-keys.ts";
import type { MeshHost } from "./mesh-host.ts";

/** The keys a host holds in its own state dir; read before the host is stopped, since stopping removes the dir. */
export const identityOf = (host: MeshHost): HostIdentity => loadHostIdentity(host.stateDir);

/** Fresh keys no member has ever seen: an outsider, or a key a compromised member mints. */
export const mintIdentity = (): HostIdentity => generateHostIdentity();
