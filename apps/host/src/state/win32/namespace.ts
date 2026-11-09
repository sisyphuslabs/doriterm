import { ADMINISTRATORS_SID, SYSTEM_SID } from "./classify.ts";
import type { Descriptor } from "./sddl.ts";

/** TrustedInstaller, which owns the Windows system folders. */
export const TRUSTED_INSTALLER_SID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";

const DELETE = 0x0001_0000;
const WRITE_DAC = 0x0004_0000;
const WRITE_OWNER = 0x0008_0000;
const FILE_DELETE_CHILD = 0x0000_0040;
const GENERIC_ALL = 0x1000_0000;
const GENERIC_WRITE = 0x4000_0000;
/** Rights that let another account rename, remove or re-ACL a folder in the chain, or the folder below it. */
const NAMESPACE_RIGHTS = DELETE | WRITE_DAC | WRITE_OWNER | FILE_DELETE_CHILD | GENERIC_ALL | GENERIC_WRITE;

export interface ChainFolder {
  /** The path checked, for the refusal message. */
  readonly path: string;
  readonly descriptor: Descriptor;
  readonly reparsePoint: boolean;
}

export type NamespaceVerdict =
  | { readonly verdict: "trusted" }
  | { readonly verdict: "untrusted"; readonly path: string; readonly reason: string };

/**
 * The trusted-namespace rule of #406 design revision 3.2, over the state folder and every ancestor up to the volume
 * or share root: a trusted owner, no other principal with rights to rename, remove or re-ACL it, and no reparse point.
 */
export function checkNamespace(chain: readonly ChainFolder[], user: string): NamespaceVerdict {
  const trustedOwners = new Set([user, SYSTEM_SID, ADMINISTRATORS_SID, TRUSTED_INSTALLER_SID]);
  for (const folder of chain) {
    if (folder.reparsePoint) return { verdict: "untrusted", path: folder.path, reason: "it is a link or junction" };
    const { owner, dacl } = folder.descriptor;
    if (!trustedOwners.has(owner))
      return { verdict: "untrusted", path: folder.path, reason: `it is owned by ${owner}` };
    if (dacl === undefined) return { verdict: "untrusted", path: folder.path, reason: "it has no access control list" };
    // Every grant is examined: a trusted principal's ACE earlier in the list must not hide a later unsafe one (#1630).
    const grant = dacl.find(
      (ace) =>
        ace.type === "A" &&
        !ace.flags.includes("IO") &&
        !trustedOwners.has(ace.sid) &&
        (ace.mask & NAMESPACE_RIGHTS) !== 0,
    );
    if (grant !== undefined) {
      return { verdict: "untrusted", path: folder.path, reason: `${grant.sid} may rename, remove or re-permission it` };
    }
  }
  return { verdict: "trusted" };
}
