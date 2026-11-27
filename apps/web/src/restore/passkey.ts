import { bytesEqual } from "@doriface/crypto";
import { storedKey } from "../connection/card-key.ts";
import { isStored } from "../connection/device-key.ts";
import { prfSalt } from "./keys.ts";

interface CredentialRef {
  readonly rawId: ArrayBuffer;
  readonly id: string;
}

interface RestoreCredential extends CredentialRef {
  readonly extensions: AuthenticationExtensionsClientOutputs;
}

interface PasskeyApi {
  create(options: CredentialCreationOptions): Promise<RestoreCredential | undefined>;
  get(options: CredentialRequestOptions): Promise<RestoreCredential | undefined>;
  capabilities?(): Promise<Readonly<Record<string, boolean>>>;
  retire?(options: { readonly rpId: string; readonly credentialId: string }): Promise<void>;
}

export const isRestoreWebKit = (agent: string): boolean =>
  /\bAppleWebKit\//.test(agent) &&
  /\b(Macintosh|iPhone|iPad|iPod)\b/.test(agent) &&
  !/\b(Chrome|Chromium|Edg|Firefox|OPR)\//.test(agent);

/** Never export durable CryptoKeys (including ones held by a WebKit version that can clone them). */
export function rawCardForEnrollment(agent: string, device: unknown, card: unknown): Uint8Array | undefined {
  if (!isRestoreWebKit(agent) || !isStored(device) || device.kind !== "raw" || !storedKey(card) || card.kind !== "raw")
    return undefined;
  return Uint8Array.from(card.privateKey);
}

const challenge = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(32));
const prf = () => ({ eval: { first: prfSalt() } });
const ref = ({ id, rawId }: CredentialRef): CredentialRef => ({ id, rawId });
const bytesOf = (source: BufferSource): Uint8Array =>
  ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);

export class RestorePasskeyError extends Error {
  override readonly name = "RestorePasskeyError";
}

/** The credential ID lives only in memory from the discovery/registration to the corresponding write. */
export class Passkey {
  readonly #rpId: string;
  readonly #api: PasskeyApi;

  constructor(rpId: string, api: PasskeyApi) {
    this.#rpId = rpId;
    this.#api = api;
  }

  async supported(): Promise<boolean> {
    const capabilities = await this.#api.capabilities?.();
    return capabilities?.["extension:prf"] !== false && capabilities?.["extension:largeBlob"] !== false;
  }

  async create(at: number): Promise<{ readonly credential: CredentialRef; readonly p0: Uint8Array }> {
    if (!(await this.supported()))
      throw new RestorePasskeyError("This browser does not support passkey PRF and largeBlob.");
    const label = `Doriterm on this phone ${new Date(at).toISOString().slice(0, 10)}`;
    const extensions = { prf: prf(), largeBlob: { support: "required" } };
    const created = await this.#api.create({
      publicKey: {
        rp: { name: "Doriterm", id: this.#rpId },
        user: { id: challenge(), name: label, displayName: label },
        challenge: challenge(),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        extensions,
      },
    });
    if (created === undefined) throw new RestorePasskeyError("The restore passkey was not created.");
    try {
      if (created.extensions.prf?.enabled !== true || created.extensions.largeBlob?.supported !== true)
        throw new RestorePasskeyError("This passkey does not support PRF and largeBlob.");
      const registered = ref(created);
      const first = created.extensions.prf.results?.first;
      const p0 = first?.byteLength === 32 ? bytesOf(first) : this.#readPrf(await this.#get({ prf: prf() }, registered));
      return { credential: registered, p0 };
    } catch (error) {
      await this.retire(created);
      throw error;
    }
  }

  async read(): Promise<{ readonly credential: CredentialRef; readonly p0: Uint8Array; readonly bytes: Uint8Array }> {
    if (!(await this.supported()))
      throw new RestorePasskeyError("This browser does not support passkey PRF and largeBlob.");
    const result = await this.#get({ prf: prf(), largeBlob: { read: true } });
    const blob = result.extensions.largeBlob?.blob;
    if (blob === undefined)
      throw new RestorePasskeyError("This passkey has no restore locator. Ask a member for an invite.");
    return { credential: ref(result), p0: this.#readPrf(result), bytes: bytesOf(blob) };
  }

  async write(credential: CredentialRef, bytes: Uint8Array): Promise<void> {
    const result = await this.#get({ largeBlob: { write: Uint8Array.from(bytes) } }, credential);
    if (result.extensions.largeBlob?.written !== true)
      throw new RestorePasskeyError("The restore locator was not written.");
  }

  async retire(credential: CredentialRef): Promise<void> {
    try {
      await this.#api.retire?.({ rpId: this.#rpId, credentialId: credential.id });
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      // If the provider cannot remove it, deleting its holder blobs still makes it inert.
    }
  }

  #readPrf(result: RestoreCredential): Uint8Array {
    const bytes = result.extensions.prf?.results?.first;
    if (bytes?.byteLength !== 32) throw new RestorePasskeyError("This passkey did not return a PRF output.");
    return bytesOf(bytes);
  }

  async #get(extensions: AuthenticationExtensionsClientInputs, credential?: CredentialRef): Promise<RestoreCredential> {
    // WebAuthn requires a singleton allow list for largeBlob writes. Discovery uses an empty list.
    const allowCredentials = credential === undefined ? [] : [{ id: credential.rawId, type: "public-key" as const }];
    const result = await this.#api.get({
      publicKey: {
        challenge: challenge(),
        rpId: this.#rpId,
        userVerification: "required",
        allowCredentials,
        extensions,
      },
    });
    if (
      result === undefined ||
      (credential !== undefined && !bytesEqual(new Uint8Array(result.rawId), new Uint8Array(credential.rawId)))
    )
      throw new RestorePasskeyError("The restore passkey was not selected.");
    return result;
  }
}

function snapshot(result: Credential | null): RestoreCredential | undefined {
  return result instanceof PublicKeyCredential
    ? { ...ref(result), extensions: result.getClientExtensionResults() }
    : undefined;
}

export function browserPasskey(): Passkey | undefined {
  if (!isRestoreWebKit(navigator.userAgent) || typeof PublicKeyCredential === "undefined") return undefined;
  return new Passkey(location.hostname, {
    create: async (options) => snapshot(await navigator.credentials.create(options)),
    get: async (options) => snapshot(await navigator.credentials.get(options)),
    ...(typeof PublicKeyCredential.getClientCapabilities !== "function"
      ? {}
      : {
          capabilities: () => PublicKeyCredential.getClientCapabilities(),
        }),
    ...(typeof PublicKeyCredential.signalUnknownCredential !== "function"
      ? {}
      : {
          retire: (options) => PublicKeyCredential.signalUnknownCredential(options),
        }),
  });
}
