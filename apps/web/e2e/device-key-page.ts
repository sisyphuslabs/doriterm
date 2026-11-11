// The device key this browser holds, read in the page by the app's own module and store: the key its Noise handshake
// presents and the key a host records when it pairs the browser. `device-key-reload.e2e.ts` bundles and serves this to
// one page, so a reload can be asked what it still presents. Nothing under src/ imports this file, so no build ships it.
import { base64urlEncode } from "@doriface/crypto";
import { loadDeviceKey } from "../src/connection/device-key.ts";

/** base64url of the X25519 static public key the page's device key holds now. */
export async function deviceKeyPublic(): Promise<string> {
  return base64urlEncode((await loadDeviceKey()).publicKey);
}
