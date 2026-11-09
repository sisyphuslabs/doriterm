import { ADMINISTRATORS_SID, SYSTEM_SID } from "./classify.ts";
import type { Ace, Descriptor } from "./sddl.ts";

export type AccountLookup =
  | { readonly status: "resolved"; readonly name: string; readonly domain: string; readonly use: number }
  | { readonly status: "unmapped" }
  | { readonly status: "unavailable"; readonly code: number };

/** Display-only lookup facts: never used to decide whether an owner or grant is trusted. */
export type LookupSid = (sid: string) => AccountLookup;

function principal(sid: string, lookup?: LookupSid): string {
  if (lookup === undefined) return `an account (SID ${sid})`;
  const account = lookup(sid);
  if (account.status === "unmapped")
    return `an account that no longer exists (SID ${sid}) or cannot currently be resolved by Windows`;
  if (account.status === "unavailable")
    return `an account Windows could not resolve (SID ${sid}; error ${String(account.code)})`;
  const kind =
    account.use === 4
      ? "a local group"
      : account.use === 2 || account.use === 5
        ? "a group"
        : account.use === 1
          ? "a user account"
          : "an account";
  const name = account.domain === "" ? account.name : `${account.domain}\\${account.name}`;
  return `${kind} named ${name}`;
}

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
  | { readonly verdict: "untrusted"; readonly path: string; readonly reason: string; readonly message: string };

function refuse(path: string, reason: string, grant?: "explicit" | "inherited"): NamespaceVerdict {
  const repair =
    grant === "explicit"
      ? `Remove the ACE granting those rights on "${path}"`
      : grant === "inherited"
        ? `Those rights are inherited from a parent folder, so they cannot be removed on "${path}" itself: ` +
          `disable inheritance on "${path}" and remove them there, or remove the grant on the parent folder`
        : `Correct the ownership or permissions (or link/junction) on "${path}"`;
  return {
    verdict: "untrusted",
    path,
    reason,
    message:
      `${path} is not safe for doriface-host's keys: ${reason}. ` +
      `The safety check covers the state folder and its parent folders. ${repair}, or set ` +
      `DORIFACE_HOST_STATE_DIR (--state-dir) to a folder that only you and SYSTEM/Administrators can modify ` +
      `(including its parent folders).`,
  };
}

const FILE_ALL_ACCESS = 0x001f_01ff;
const FILE_GENERIC_READ = 0x0012_0089;
const FILE_GENERIC_WRITE = 0x0012_0116;
const FILE_GENERIC_EXECUTE = 0x0012_00a0;
const GENERIC_READ = 0x8000_0000;
const GENERIC_EXECUTE = 0x2000_0000;

/** The file generic mapping Windows applies when a generic right is inherited as an effective ACE. */
function mapGeneric(mask: number): number {
  let mapped = mask & ~(GENERIC_READ | GENERIC_WRITE | GENERIC_EXECUTE | GENERIC_ALL);
  if ((mask & GENERIC_ALL) !== 0) mapped |= FILE_ALL_ACCESS;
  if ((mask & GENERIC_READ) !== 0) mapped |= FILE_GENERIC_READ;
  if ((mask & GENERIC_WRITE) !== 0) mapped |= FILE_GENERIC_WRITE;
  if ((mask & GENERIC_EXECUTE) !== 0) mapped |= FILE_GENERIC_EXECUTE;
  return mapped >>> 0;
}

/** Follow only a continuous, matching container-inheritance chain; never guess across a missing ACE or boundary. */
function grantSource(
  chain: readonly ChainFolder[],
  index: number,
  folder: ChainFolder,
  grant: Ace,
): { readonly path: string; readonly inherited: boolean } {
  let source = folder;
  let ace = grant;
  while (ace.flags.includes("ID") && !source.descriptor.protected) {
    const parent = chain[index + 1];
    const inheritedFrom = parent?.descriptor.dacl?.find(
      (candidate) =>
        candidate.type === ace.type &&
        candidate.sid === ace.sid &&
        (candidate.mask === ace.mask || mapGeneric(candidate.mask) === ace.mask) &&
        candidate.flags.includes("CI") &&
        (!candidate.flags.includes("NP") || (!ace.flags.includes("CI") && !ace.flags.includes("OI"))),
    );
    if (parent === undefined || inheritedFrom === undefined) break;
    source = parent;
    ace = inheritedFrom;
    index += 1;
  }
  return { path: source.path, inherited: ace.flags.includes("ID") && !source.descriptor.protected };
}

/**
 * The trusted-namespace rule of #406 design revision 3.2, over the state folder and every ancestor up to the volume
 * or share root: a trusted owner, no other principal with rights to rename, remove or re-ACL it, and no reparse point.
 */
export function checkNamespace(chain: readonly ChainFolder[], user: string, lookup?: LookupSid): NamespaceVerdict {
  const trustedOwners = new Set([user, SYSTEM_SID, ADMINISTRATORS_SID, TRUSTED_INSTALLER_SID]);
  for (const [index, folder] of chain.entries()) {
    if (folder.reparsePoint) return refuse(folder.path, "it is a link or junction");
    const { owner, dacl } = folder.descriptor;
    if (!trustedOwners.has(owner)) return refuse(folder.path, `it is owned by ${principal(owner, lookup)}`);
    if (dacl === undefined) return refuse(folder.path, "it has no access control list");
    const grant = dacl.find(
      (ace) => ace.type === "A" && !ace.flags.includes("IO") && ace.sid !== user && (ace.mask & NAMESPACE_RIGHTS) !== 0,
    );
    if (grant !== undefined && !trustedOwners.has(grant.sid)) {
      const source = grantSource(chain, index, folder, grant);
      return refuse(
        source.path,
        `${principal(grant.sid, lookup)} may rename, remove or re-permission it`,
        source.inherited ? "inherited" : "explicit",
      );
    }
  }
  return { verdict: "trusted" };
}
