/**
 * The Win32 calls behind private state on Windows (#406, design revision 3 section 1), through `bun:ffi`: only
 * kernel32, advapi32 and ntdll, all part of Windows. Handles travel as u64 BigInts; every buffer Windows allocates is
 * released with LocalFree. Opens go through NtCreateFile, whose status is the call's own result (#464); the other failed
 * calls throw with GetLastError.
 */
import { dlopen, ptr, read, toArrayBuffer } from "bun:ffi";
import { ntPath, ntRequest, type OpenOptions, openRetrying, Win32Error } from "./nt-open.ts";
import type { AccountLookup } from "./namespace.ts";

export { type OpenOptions, Win32Error } from "./nt-open.ts";

export type Handle = bigint;

export const GENERIC_READ = 0x8000_0000;
export const GENERIC_WRITE = 0x4000_0000;
export const READ_CONTROL = 0x0002_0000;
export const WRITE_DAC = 0x0004_0000;
export const WRITE_OWNER = 0x0008_0000;
export const FILE_SHARE_READ = 0x1;
export const FILE_SHARE_WRITE = 0x2;
export const CREATE_NEW = 1;
export const OPEN_EXISTING = 3;
export const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
export const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
export const FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
export const FILE_FLAG_WRITE_THROUGH = 0x8000_0000;
export const MOVEFILE_REPLACE_EXISTING = 0x1;
export const MOVEFILE_WRITE_THROUGH = 0x8;
export const ERROR_FILE_NOT_FOUND = 2;
export const ERROR_PATH_NOT_FOUND = 3;
export const ERROR_ALREADY_EXISTS = 183;
export const ERROR_FILE_EXISTS = 80;

const SE_FILE_OBJECT = 1;
const OWNER_SECURITY_INFORMATION = 0x1;
const DACL_SECURITY_INFORMATION = 0x4;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x8000_0000;
const SDDL_REVISION_1 = 1;
const TOKEN_QUERY = 0x8;
const TOKEN_USER_CLASS = 1;

const u64 = "u64" as const;
const u32 = "u32" as const;
const i32 = "i32" as const;
const pointer = "ptr" as const;

function load() {
  const kernel32 = dlopen("kernel32.dll", {
    CreateDirectoryW: { args: [pointer, pointer], returns: i32 },
    ReadFile: { args: [u64, pointer, u32, pointer, pointer], returns: i32 },
    WriteFile: { args: [u64, pointer, u32, pointer, pointer], returns: i32 },
    FlushFileBuffers: { args: [u64], returns: i32 },
    CloseHandle: { args: [u64], returns: i32 },
    GetFileInformationByHandle: { args: [u64, pointer], returns: i32 },
    MoveFileExW: { args: [pointer, pointer, u32], returns: i32 },
    DeleteFileW: { args: [pointer], returns: i32 },
    GetLastError: { args: [], returns: u32 },
    LocalFree: { args: [u64], returns: u64 },
    lstrlenW: { args: [u64], returns: i32 },
    GetCurrentProcess: { args: [], returns: u64 },
  });
  const advapi32 = dlopen("advapi32.dll", {
    OpenProcessToken: { args: [u64, u32, pointer], returns: i32 },
    GetTokenInformation: { args: [u64, u32, pointer, u32, pointer], returns: i32 },
    ConvertSidToStringSidW: { args: [u64, pointer], returns: i32 },
    ConvertStringSidToSidW: { args: [pointer, pointer], returns: i32 },
    LookupAccountSidW: { args: [pointer, u64, pointer, pointer, pointer, pointer, pointer], returns: i32 },
    GetSecurityInfo: { args: [u64, u32, u32, pointer, pointer, pointer, pointer, pointer], returns: u32 },
    SetSecurityInfo: { args: [u64, u32, u32, u64, u64, u64, u64], returns: u32 },
    ConvertSecurityDescriptorToStringSecurityDescriptorW: { args: [u64, u32, u32, pointer, pointer], returns: i32 },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: [pointer, u32, pointer, pointer], returns: i32 },
    GetSecurityDescriptorDacl: { args: [u64, pointer, pointer, pointer], returns: i32 },
    GetSecurityDescriptorOwner: { args: [u64, pointer, pointer], returns: i32 },
  });
  // NtCreateFile returns its own NTSTATUS: the reason an open failed is never read from a later call (#464).
  const ntdll = dlopen("ntdll.dll", {
    NtCreateFile: {
      args: [pointer, u32, pointer, pointer, pointer, u32, u32, u32, u32, pointer, u32],
      returns: u32,
    },
    RtlNtStatusToDosError: { args: [u32], returns: u32 },
  });
  return { k: kernel32.symbols, a: advapi32.symbols, n: ntdll.symbols };
}

let symbols: ReturnType<typeof load> | undefined;
const api = (): ReturnType<typeof load> => (symbols ??= load());

const fail = (call: string): never => {
  throw new Win32Error(call, api().k.GetLastError());
};

/** A NUL-terminated UTF-16LE copy of `text` for a W function; the caller keeps it alive across the call. */
const wide = (text: string): Buffer => Buffer.from(`${text}\0`, "utf16le");

/** The UTF-16 string Windows wrote at `address`, up to its NUL. */
function readWide(address: bigint): string {
  const length = api().k.lstrlenW(address);
  return Buffer.from(toArrayBuffer(Number(address), 0, length * 2)).toString("utf16le");
}

const outPointer = (): BigUint64Array => new BigUint64Array(1);
const valueOf = (cell: BigUint64Array): bigint => cell[0] ?? 0n;

/** Frees a buffer Windows allocated for us; a pointer of 0 is nothing to free. */
function localFree(address: bigint): void {
  if (address !== 0n && api().k.LocalFree(address) !== 0n) fail("LocalFree");
}

export function closeHandle(handle: Handle): void {
  if (api().k.CloseHandle(handle) === 0) fail("CloseHandle");
}

/** The current process user's SID as `S-1-…`, from the process token: no PATH, no names, no localization. */
export function currentUserSid(): string {
  const { k, a } = api();
  const token = outPointer();
  if (a.OpenProcessToken(k.GetCurrentProcess(), TOKEN_QUERY, ptr(token)) === 0) fail("OpenProcessToken");
  try {
    const needed = new Uint32Array(1);
    a.GetTokenInformation(valueOf(token), TOKEN_USER_CLASS, null, 0, ptr(needed));
    const buffer = new Uint8Array(needed[0] ?? 0);
    if (buffer.byteLength === 0) fail("GetTokenInformation");
    if (a.GetTokenInformation(valueOf(token), TOKEN_USER_CLASS, ptr(buffer), buffer.byteLength, ptr(needed)) === 0) {
      fail("GetTokenInformation");
    }
    // TOKEN_USER starts with SID_AND_ATTRIBUTES, whose first field is the PSID.
    const sid = read.u64(ptr(buffer), 0);
    const text = outPointer();
    if (a.ConvertSidToStringSidW(sid, ptr(text)) === 0) fail("ConvertSidToStringSidW");
    try {
      return readWide(valueOf(text));
    } finally {
      localFree(valueOf(text));
    }
  } finally {
    closeHandle(valueOf(token));
  }
}

/**
 * The full `S-1-…` SID for an SDDL alias, as Windows itself resolves it on this computer (domain-relative aliases such
 * as `LA` included); undefined when Windows does not know the alias.
 */
export function resolveSidAlias(alias: string): string | undefined {
  const { a } = api();
  const text = wide(alias);
  const sid = outPointer();
  if (a.ConvertStringSidToSidW(ptr(text), ptr(sid)) === 0) return undefined;
  try {
    const out = outPointer();
    if (a.ConvertSidToStringSidW(valueOf(sid), ptr(out)) === 0) fail("ConvertSidToStringSidW");
    try {
      return readWide(valueOf(out));
    } finally {
      localFree(valueOf(out));
    }
  } finally {
    localFree(valueOf(sid));
  }
}

/** Resolve a principal for diagnostics only. Failed lookups must not replace the original safety refusal. */
export function lookupAccountSid(sidText: string): AccountLookup {
  const { a, k } = api();
  const text = wide(sidText);
  const sid = outPointer();
  const failure = (): AccountLookup => {
    const code = k.GetLastError();
    return code === 1332 ? { status: "unmapped" } : { status: "unavailable", code };
  };
  if (a.ConvertStringSidToSidW(ptr(text), ptr(sid)) === 0) return failure();
  try {
    const nameSize = new Uint32Array(1);
    const domainSize = new Uint32Array(1);
    const use = new Uint32Array(1);
    a.LookupAccountSidW(null, valueOf(sid), null, ptr(nameSize), null, ptr(domainSize), ptr(use));
    // ERROR_INSUFFICIENT_BUFFER is the expected sizing result; sizes are UTF-16 code units, including NUL.
    if (k.GetLastError() !== 122) return failure();
    const name = Buffer.alloc((nameSize[0] ?? 0) * 2);
    const domain = Buffer.alloc(Math.max(domainSize[0] ?? 0, 1) * 2);
    if (a.LookupAccountSidW(null, valueOf(sid), ptr(name), ptr(nameSize), ptr(domain), ptr(domainSize), ptr(use)) === 0)
      return failure();
    return {
      status: "resolved",
      name: name.toString("utf16le").replace(/\0.*$/s, ""),
      domain: domain.toString("utf16le").replace(/\0.*$/s, ""),
      use: use[0] ?? 0,
    };
  } finally {
    localFree(valueOf(sid));
  }
}

/** A self-relative security descriptor built from SDDL; release it with {@link freeDescriptor}. */
export function descriptorFromSddl(sddl: string): bigint {
  const text = wide(sddl);
  const out = outPointer();
  if (api().a.ConvertStringSecurityDescriptorToSecurityDescriptorW(ptr(text), SDDL_REVISION_1, ptr(out), null) === 0) {
    fail("ConvertStringSecurityDescriptorToSecurityDescriptorW");
  }
  return valueOf(out);
}

export const freeDescriptor = (descriptor: bigint): void => localFree(descriptor);

const OBJ_CASE_INSENSITIVE = 0x40;

/**
 * Opens or creates `path` as CreateFileW would, through NtCreateFile so a failure carries its own status: a file another
 * process holds without sharing is waited for (bounded), and every other failure throws a Win32Error with the true code.
 */
export function openFile(path: string, options: OpenOptions): Handle {
  const request = ntRequest(options);
  const name = Buffer.from(ntPath(path), "utf16le");
  // UNICODE_STRING: USHORT Length, USHORT MaximumLength, 4 bytes of padding, PWSTR Buffer.
  const unicode = new Uint8Array(16);
  const unicodeView = new DataView(unicode.buffer);
  unicodeView.setUint16(0, name.byteLength, true);
  unicodeView.setUint16(2, name.byteLength, true);
  unicodeView.setBigUint64(8, BigInt(ptr(name)), true);
  // OBJECT_ATTRIBUTES on 64-bit Windows: Length, RootDirectory, ObjectName, Attributes, SecurityDescriptor, QoS.
  const attributes = new Uint8Array(48);
  const view = new DataView(attributes.buffer);
  view.setUint32(0, 48, true);
  view.setBigUint64(16, BigInt(ptr(unicode)), true);
  view.setUint32(24, OBJ_CASE_INSENSITIVE, true);
  view.setBigUint64(32, options.descriptor ?? 0n, true);
  const status = new Uint8Array(16);
  const out = new BigUint64Array(1);
  return openRetrying(
    () => ({
      status: api().n.NtCreateFile(
        ptr(out),
        request.access,
        ptr(attributes),
        ptr(status),
        null,
        request.attributes,
        request.share,
        request.disposition,
        request.createOptions,
        null,
        0,
      ),
      handle: out[0] ?? 0n,
    }),
    (code) => api().n.RtlNtStatusToDosError(code),
    (ms) => Bun.sleepSync(ms),
  );
}

/** CreateDirectoryW with an exact descriptor; false when the folder already exists. */
export function createDirectory(path: string, descriptor: bigint): boolean {
  const name = wide(path);
  const attributes = new Uint8Array(24);
  const view = new DataView(attributes.buffer);
  view.setUint32(0, 24, true);
  view.setBigUint64(8, descriptor, true);
  if (api().k.CreateDirectoryW(ptr(name), ptr(attributes)) !== 0) return true;
  const code = api().k.GetLastError();
  if (code === ERROR_ALREADY_EXISTS) return false;
  throw new Win32Error("CreateDirectoryW", code);
}

export interface FileFacts {
  readonly attributes: number;
  readonly links: number;
  readonly size: number;
}

/** GetFileInformationByHandle: attributes (reparse point?), link count and size. */
export function fileFacts(handle: Handle): FileFacts {
  const info = new Uint8Array(52);
  if (api().k.GetFileInformationByHandle(handle, ptr(info)) === 0) fail("GetFileInformationByHandle");
  const view = new DataView(info.buffer);
  return {
    attributes: view.getUint32(0, true),
    size: view.getUint32(32, true) * 2 ** 32 + view.getUint32(36, true),
    links: view.getUint32(40, true),
  };
}

/** The handle's owner and DACL as SDDL (`O:…D:…`), read through the handle itself. */
export function readSddl(handle: Handle): string {
  const { a } = api();
  const descriptor = outPointer();
  const info = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
  const status = a.GetSecurityInfo(handle, SE_FILE_OBJECT, info, null, null, null, null, ptr(descriptor));
  if (status !== 0) throw new Win32Error("GetSecurityInfo", status);
  try {
    const text = outPointer();
    if (
      a.ConvertSecurityDescriptorToStringSecurityDescriptorW(
        valueOf(descriptor),
        SDDL_REVISION_1,
        info,
        ptr(text),
        null,
      ) === 0
    ) {
      fail("ConvertSecurityDescriptorToStringSecurityDescriptorW");
    }
    try {
      return readWide(valueOf(text));
    } finally {
      localFree(valueOf(text));
    }
  } finally {
    localFree(valueOf(descriptor));
  }
}

/** Replaces the handle's owner and DACL with exactly those in `sddl`, marking the DACL protected (no inheritance). */
export function writeOwnerAndProtectedDacl(handle: Handle, sddl: string): void {
  const { a } = api();
  const descriptor = descriptorFromSddl(sddl);
  try {
    const present = new Int32Array(1);
    const defaulted = new Int32Array(1);
    const dacl = outPointer();
    const owner = outPointer();
    if (a.GetSecurityDescriptorDacl(descriptor, ptr(present), ptr(dacl), ptr(defaulted)) === 0 || present[0] === 0) {
      fail("GetSecurityDescriptorDacl");
    }
    if (a.GetSecurityDescriptorOwner(descriptor, ptr(owner), ptr(defaulted)) === 0) fail("GetSecurityDescriptorOwner");
    const info = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
    const status = a.SetSecurityInfo(handle, SE_FILE_OBJECT, info, valueOf(owner), 0n, valueOf(dacl), 0n);
    if (status !== 0) throw new Win32Error("SetSecurityInfo", status);
  } finally {
    freeDescriptor(descriptor);
  }
}

export function readAll(handle: Handle, size: number): Buffer {
  const buffer = Buffer.alloc(size);
  const done = new Uint32Array(1);
  let offset = 0;
  while (offset < size) {
    const chunk = buffer.subarray(offset);
    if (api().k.ReadFile(handle, ptr(chunk), chunk.byteLength, ptr(done), null) === 0) fail("ReadFile");
    const count = done[0] ?? 0;
    if (count === 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset);
}

export function writeAll(handle: Handle, bytes: Uint8Array): void {
  const done = new Uint32Array(1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const chunk = bytes.subarray(offset);
    if (api().k.WriteFile(handle, ptr(chunk), chunk.byteLength, ptr(done), null) === 0) fail("WriteFile");
    offset += done[0] ?? 0;
  }
  if (api().k.FlushFileBuffers(handle) === 0) fail("FlushFileBuffers");
}

/** MoveFileExW with write-through; `replace` false fails with ERROR_ALREADY_EXISTS rather than overwrite. */
export function moveFile(from: string, to: string, replace: boolean): void {
  const flags = MOVEFILE_WRITE_THROUGH | (replace ? MOVEFILE_REPLACE_EXISTING : 0);
  const source = wide(from);
  const target = wide(to);
  if (api().k.MoveFileExW(ptr(source), ptr(target), flags) === 0) fail("MoveFileExW");
}

export function deleteFile(path: string): void {
  const name = wide(path);
  if (api().k.DeleteFileW(ptr(name)) === 0) fail("DeleteFileW");
}
