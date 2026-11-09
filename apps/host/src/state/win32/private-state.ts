/**
 * Private state on Windows (#406, design revisions 3, 3.1 and 3.2): the state folder and every private file in it
 * carry an exact, protected owner-only DACL; every read classifies the file on the same handle it reads; nothing is
 * changed before the whole folder has been classified; and the namespace above the folder is checked first.
 */
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { classifyCustody, type Custody } from "./classify.ts";
import {
  closeHandle,
  createDirectory,
  CREATE_NEW,
  deleteFile,
  descriptorFromSddl,
  ERROR_ALREADY_EXISTS,
  ERROR_FILE_EXISTS,
  ERROR_FILE_NOT_FOUND,
  ERROR_PATH_NOT_FOUND,
  FILE_ATTRIBUTE_REPARSE_POINT,
  FILE_FLAG_BACKUP_SEMANTICS,
  FILE_FLAG_OPEN_REPARSE_POINT,
  FILE_FLAG_WRITE_THROUGH,
  FILE_SHARE_READ,
  FILE_SHARE_WRITE,
  fileFacts,
  freeDescriptor,
  GENERIC_READ,
  GENERIC_WRITE,
  type Handle,
  moveFile,
  OPEN_EXISTING,
  openFile,
  READ_CONTROL,
  readAll,
  readSddl,
  Win32Error,
  WRITE_DAC,
  WRITE_OWNER,
  writeAll,
  writeOwnerAndProtectedDacl,
  currentUserSid,
  resolveSidAlias,
} from "./native.ts";
import { pidIsLive } from "../lock.ts";
import { PrivateStateRefused } from "../private-state-refused.ts";
import { checkNamespace, type ChainFolder } from "./namespace.ts";
import { parseSddl, SddlError } from "./sddl.ts";

/** Every file the host keeps private in its state folder; `readJson` and the private writers are its only paths. */
export const PRIVATE_STATE_FILES = [
  "host-keys.json",
  "device-key.json",
  "known-hosts.json",
  "devices.json",
  "pairing.json",
  "push-vapid.json",
  "push-subscriptions.json",
  "relay-passes.json",
  "mesh.json",
  "roster-admits.json",
] as const;

/** The temporary files this host's writers leave only when a crash interrupts them. */
const TEMPORARY = /\.(\d+)\.[0-9a-f-]+\.tmp$/;

const ownerOnlyFile = (user: string): string => `O:${user}D:P(A;;FA;;;${user})`;
const ownerOnlyFolder = (user: string): string => `O:${user}D:P(A;OICI;FA;;;${user})`;

let userSid: string | undefined;
const user = (): string => (userSid ??= currentUserSid());

const isMissing = (error: unknown): boolean =>
  error instanceof Win32Error && (error.code === ERROR_FILE_NOT_FOUND || error.code === ERROR_PATH_NOT_FOUND);

const folderOptions = {
  access: READ_CONTROL,
  share: FILE_SHARE_READ | FILE_SHARE_WRITE,
  disposition: OPEN_EXISTING,
  flags: FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
};

function withHandle<T>(handle: Handle, use: (handle: Handle) => T): T {
  try {
    return use(handle);
  } finally {
    closeHandle(handle);
  }
}

/** The custody of the object behind `handle`, with what the handle says about links and reparse points. */
function custodyOf(handle: Handle): Custody {
  const facts = fileFacts(handle);
  if ((facts.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
    return { verdict: "unsupported", reason: "it is a link or junction" };
  }
  if (facts.links !== 1) return { verdict: "unsupported", reason: `it has ${String(facts.links)} hard links` };
  try {
    return classifyCustody(parseSddl(readSddl(handle), resolveSidAlias), user());
  } catch (error) {
    if (error instanceof SddlError) return { verdict: "unsupported", reason: `its permissions: ${error.message}` };
    throw error;
  }
}

function refusal(path: string, custody: Custody): string {
  if (custody.verdict === "exposed") {
    const removals = custody.principals.map((sid) => `/remove:g *${sid}`).join(" ");
    return (
      `${path} can be read or changed by other accounts on this computer (${custody.principals.join(", ")}): run ` +
      `icacls "${path}" /inheritance:r /grant:r *${user()}:F ${removals} to keep it, or delete it`
    );
  }
  return custody.verdict === "unsupported"
    ? `${path} cannot be trusted as private state: ${custody.reason}`
    : `${path} is not private`;
}

/** The folders from `dir` up to its volume or share root, as the namespace rule checks them. */
function chainOf(dir: string): ChainFolder[] {
  const chain: ChainFolder[] = [];
  const root = parsePath(dir).root;
  for (let current = dir; ; current = dirname(current)) {
    chain.push(
      withHandle(openFile(current, folderOptions), (handle) => ({
        path: current,
        descriptor: parseSddl(readSddl(handle), resolveSidAlias),
        reparsePoint: (fileFacts(handle).attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
      })),
    );
    if (current === root || dirname(current) === current) return chain;
  }
}

/** The handles of state folders already opened by this process: held, so the folder cannot be renamed under it. */
const opened = new Map<string, Handle>();

/**
 * Opens a state folder for private state, once per process: checks the namespace, creates the folder protected if it
 * is missing, classifies every private file without changing anything, and only then makes the owner-approved
 * branch-(a) repairs. Throws PrivateStateRefused, changing nothing, when anything is exposed or untrusted.
 */
export function openPrivateStateDir(requested: string): string {
  const dir = resolve(requested);
  if (opened.has(dir)) return dir;
  mkdirSync(dirname(dir), { recursive: true });
  const descriptor = descriptorFromSddl(ownerOnlyFolder(user()));
  try {
    createDirectory(dir, descriptor);
  } finally {
    freeDescriptor(descriptor);
  }
  const namespace = checkNamespace(chainOf(dir), user());
  if (namespace.verdict === "untrusted") {
    throw new PrivateStateRefused(
      `${namespace.path} is not safe for doriface-host's keys: ${namespace.reason}. Use a state folder under your ` +
        `user profile (--state-dir or DORIFACE_HOST_STATE_DIR), or remove those rights`,
    );
  }
  const folder = openFile(dir, {
    access: READ_CONTROL | WRITE_DAC | WRITE_OWNER,
    share: FILE_SHARE_READ | FILE_SHARE_WRITE,
    disposition: OPEN_EXISTING,
    flags: FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
  });
  try {
    const repairs: string[] = [];
    const leftovers: string[] = [];
    const problems: string[] = [];
    const folderCustody = classifyCustody(parseSddl(readSddl(folder), resolveSidAlias), user());
    if (folderCustody.verdict === "repairable") repairs.push(dir);
    else if (folderCustody.verdict !== "private") problems.push(refusal(dir, folderCustody));
    const names = new Set<string>(PRIVATE_STATE_FILES);
    for (const name of readdirSync(dir)) {
      const writer = TEMPORARY.exec(name)?.[1];
      const temporary = writer !== undefined;
      // A live process's temporary file is mid-write and the state lock sweeps its own: neither is debris to remove.
      if (temporary && (name.startsWith("state.lock.") || pidIsLive(Number(writer)))) continue;
      if (!names.has(name) && !temporary) continue;
      const path = join(dir, name);
      const custody = withHandle(openFile(path, { ...folderOptions, flags: FILE_FLAG_OPEN_REPARSE_POINT }), custodyOf);
      if (custody.verdict === "repairable") repairs.push(path);
      else if (custody.verdict !== "private") problems.push(refusal(path, custody));
      else if (temporary) leftovers.push(path);
    }
    // Nothing has been changed yet: an exposure found anywhere stays in place for the next start to find again.
    if (problems.length > 0) throw new PrivateStateRefused(problems.join("\n"));
    for (const path of repairs) protect(path, path === dir);
    for (const path of leftovers) deleteFile(path);
  } catch (error) {
    closeHandle(folder);
    throw error;
  }
  opened.set(dir, folder);
  return dir;
}

/** Branch (a): replaces the object's owner and DACL with the exact protected owner-only form, then reads it back. */
function protect(path: string, folder: boolean): void {
  const handle = openFile(path, {
    access: READ_CONTROL | WRITE_DAC | WRITE_OWNER,
    share: FILE_SHARE_READ | FILE_SHARE_WRITE,
    disposition: OPEN_EXISTING,
    flags: FILE_FLAG_OPEN_REPARSE_POINT | (folder ? FILE_FLAG_BACKUP_SEMANTICS : 0),
  });
  withHandle(handle, () => {
    writeOwnerAndProtectedDacl(handle, folder ? ownerOnlyFolder(user()) : ownerOnlyFile(user()));
    const after = classifyCustody(parseSddl(readSddl(handle), resolveSidAlias), user());
    if (after.verdict !== "private")
      throw new PrivateStateRefused(`${path} could not be made private: ${after.verdict}`);
  });
}

/** The bytes of a private file, classified on the handle they are read from; undefined when it does not exist. */
export function readPrivateFile(path: string): Buffer | undefined {
  let handle: Handle;
  try {
    handle = openFile(path, {
      access: GENERIC_READ | READ_CONTROL,
      share: FILE_SHARE_READ,
      disposition: OPEN_EXISTING,
      flags: FILE_FLAG_OPEN_REPARSE_POINT,
    });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  return withHandle(handle, () => {
    const custody = custodyOf(handle);
    if (custody.verdict !== "private") throw new PrivateStateRefused(refusal(path, custody));
    return readAll(handle, fileFacts(handle).size);
  });
}

const temporaryFor = (path: string): string => `${path}.${String(process.pid)}.${crypto.randomUUID()}.tmp`;

/**
 * Writes `bytes` to a new temporary file created with the exact owner-only descriptor, verified on its handle before
 * the first byte; a file system that does not keep the descriptor is refused with nothing written.
 */
function writeTemporary(path: string, bytes: Uint8Array): string {
  const temporary = temporaryFor(path);
  const descriptor = descriptorFromSddl(ownerOnlyFile(user()));
  let handle: Handle;
  try {
    handle = openFile(temporary, {
      access: GENERIC_WRITE | READ_CONTROL,
      share: 0,
      disposition: CREATE_NEW,
      flags: FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT,
      descriptor,
    });
  } finally {
    freeDescriptor(descriptor);
  }
  try {
    withHandle(handle, () => {
      const custody = custodyOf(handle);
      if (custody.verdict !== "private") {
        throw new PrivateStateRefused(
          `the drive holding ${path} does not keep Windows permissions (${custody.verdict}): move the state folder to ` +
            `an NTFS or ReFS drive`,
        );
      }
      writeAll(handle, bytes);
    });
  } catch (error) {
    deleteFile(temporary);
    throw error;
  }
  return temporary;
}

/** Creates `path` only if it does not exist; false when another writer's file is already there. */
export function createPrivateFile(path: string, bytes: Uint8Array): boolean {
  const temporary = writeTemporary(path, bytes);
  try {
    moveFile(temporary, path, false);
    return true;
  } catch (error) {
    deleteFile(temporary);
    if (error instanceof Win32Error && (error.code === ERROR_ALREADY_EXISTS || error.code === ERROR_FILE_EXISTS)) {
      return false;
    }
    throw error;
  }
}

export function replacePrivateFile(path: string, bytes: Uint8Array): void {
  const temporary = writeTemporary(path, bytes);
  try {
    moveFile(temporary, path, true);
  } catch (error) {
    deleteFile(temporary);
    throw error;
  }
}
