import { base64urlDecode, hostIdOf } from "@doriface/crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { checkName } from "../names.ts";
import { isObject } from "./json.ts";
import { isKey, isNonce, isSignature, signWith, signatureMessage, verifiesWith } from "./signature.ts";
import type { CardBody } from "./types.ts";

const REQUEST = "doriterm readmit v1";
const APPROVAL = "doriterm approve readmit v1";
const BUNDLE = "doriterm restore bundle v1";

export interface ReadmitFields {
  readonly old: string;
  readonly signPub: string;
  readonly noise: string;
  readonly name: string;
  readonly nonce: string;
  readonly at: number;
}

export interface ReadmitApproval {
  readonly by: string;
  readonly sig: string;
}

export interface ReadmitSubject extends ReadmitFields {
  readonly newSig: string;
  readonly oldSig?: string;
  readonly approval?: ReadmitApproval;
  /** If the old device is live as well as another member, both approve. */
  readonly oldApproval?: string;
}

export function parseReadmitApproval(raw: unknown): ReadmitApproval | undefined {
  if (!isObject(raw)) return undefined;
  const { by, sig } = raw;
  return isKey(by) && isSignature(sig) ? { by, sig } : undefined;
}

export function parseReadmit(raw: unknown): ReadmitSubject | undefined {
  if (!isObject(raw)) return undefined;
  const { old, signPub, noise, name, nonce, at, newSig, oldSig, oldApproval } = raw;
  if (!isKey(old) || !isKey(signPub) || signPub === old || !isKey(noise) || !isNonce(nonce)) return undefined;
  if (typeof name !== "string" || !checkName(name)) return undefined;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) return undefined;
  if (!isSignature(newSig) || (oldSig !== undefined && !isSignature(oldSig))) return undefined;
  if (oldApproval !== undefined && (oldSig === undefined || !isSignature(oldApproval))) return undefined;
  const approval = parseReadmitApproval(raw["approval"]);
  if (raw["approval"] !== undefined && approval === undefined) return undefined;
  return {
    old,
    signPub,
    noise,
    name,
    nonce,
    at,
    newSig,
    ...(oldSig === undefined ? {} : { oldSig }),
    ...(approval === undefined ? {} : { approval }),
    ...(oldApproval === undefined ? {} : { oldApproval }),
  };
}

/** No JavaScript property order or outer publisher is part of this proof. Retrying never re-signs it. */
const requestBytes = (mesh: string, r: ReadmitFields): string =>
  JSON.stringify([mesh, r.old, r.signPub, r.noise, r.name, r.nonce, r.at]);

export const signReadmit = (mesh: string, request: ReadmitFields, secret: Uint8Array): string =>
  signWith(REQUEST, requestBytes(mesh, request), secret).sig;

export const approveReadmit = (mesh: string, request: ReadmitFields, secret: Uint8Array): string =>
  signWith(APPROVAL, requestBytes(mesh, request), secret).sig;

export const readmitApprovalMessage = (mesh: string, request: ReadmitFields): Uint8Array =>
  signatureMessage(APPROVAL, requestBytes(mesh, request));

export function verifyReadmit(mesh: string, r: ReadmitSubject): boolean {
  const body = requestBytes(mesh, r);
  if (!verifiesWith(REQUEST, { body, sig: r.newSig }, r.signPub)) return false;
  if (r.oldSig !== undefined && !verifiesWith(REQUEST, { body, sig: r.oldSig }, r.old)) return false;
  if (r.oldApproval !== undefined && !verifiesWith(APPROVAL, { body, sig: r.oldApproval }, r.old)) return false;
  return r.approval === undefined || verifiesWith(APPROVAL, { body, sig: r.approval.sig }, r.approval.by);
}

/** Comparison code committed to the exact signed request on both screens. */
export function readmitCode(mesh: string, request: ReadmitFields): string {
  const bytes = sha256(new TextEncoder().encode(requestBytes(mesh, request)));
  return (new DataView(bytes.buffer, bytes.byteOffset).getUint32(0) % 1_000_000).toString().padStart(6, "0");
}

export const signBundleChallenge = (challenge: string, secret: Uint8Array): string =>
  signWith(BUNDLE, challenge, secret).sig;

export const verifyBundleChallenge = (challenge: string, sig: string, signPub: string): boolean =>
  verifiesWith(BUNDLE, { body: challenge, sig }, signPub);

/** The readmit's possession proof is its client card; the authenticated record supplies the machine admitter. */
export function readmittedCard(mesh: string, by: string, r: ReadmitSubject): CardBody {
  return {
    v: 2,
    kind: "client",
    mesh,
    inviter: by,
    nonce: r.nonce,
    hostId: hostIdOf(base64urlDecode(r.signPub)),
    signPub: r.signPub,
    noisePub: r.noise,
    devicePub: r.noise,
    name: r.name,
    hcId: "",
  };
}
