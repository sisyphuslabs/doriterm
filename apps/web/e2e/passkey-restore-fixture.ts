import { base64urlEncode, generateHostIdentity } from "@doriface/crypto";
import { approveReadmit, hashOf, signCard, signReadmit, signRecord } from "@doriface/mesh";
import type { Signed } from "@doriface/mesh";
import { cardBodyFor } from "@doriface/mesh/join";
import type { Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { browserMeshFixture } from "./browser-mesh-fixture.ts";

export const ios = "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1";
export const at = 1_795_747_200_000;
const pub = (identity: ReturnType<typeof generateHostIdentity>) => base64urlEncode(identity.sign.publicKey);
const noise = (identity: ReturnType<typeof generateHostIdentity>) => base64urlEncode(identity.noise.publicKey);
const p0 = new Uint8Array(32).fill(7);

export async function passkey(page: Page, locator: Uint8Array) {
  await page.addInitScript(
    ({ agent, prf, blob }) => {
      Object.defineProperty(Navigator.prototype, "userAgent", { configurable: true, get: () => agent });
      class Credential {
        readonly rawId = new Uint8Array(32).buffer;
        readonly id = "virtual-icloud-passkey";
        getClientExtensionResults() {
          return {
            prf: { results: { first: new Uint8Array(prf).buffer } },
            largeBlob: { blob: new Uint8Array(blob).buffer },
          };
        }
      }
      Object.defineProperty(window, "PublicKeyCredential", { value: Credential });
      Object.defineProperty(navigator.credentials, "get", {
        value: async (request: CredentialRequestOptions) => {
          if (request.publicKey?.extensions?.largeBlob?.write !== undefined)
            throw new DOMException("Declined", "NotAllowedError");
          return new Credential();
        },
      });
    },
    { agent: ios, prf: [...p0], blob: [...locator] },
  );
}

export async function restorePartition() {
  const proc = spawn("bun", [fileURLToPath(new URL("./passkey-restore-server.ts", import.meta.url))], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const output = createInterface({ input: proc.stdout });
  const ended = new Promise<void>((resolve) => proc.once("close", () => resolve()));
  const clean = async () => {
    proc.kill();
    await ended;
    output.close();
  };
  try {
    const info = await new Promise<{
      readonly url: string;
      readonly holderIds: string[];
      readonly locator: number[];
      readonly records: Signed[];
      readonly old: string;
    }>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", (code) => reject(new Error(`holder fixture exited: ${code}`)));
      output.once("line", (line) => resolve(JSON.parse(line)));
    });
    const holders = info.holderIds.map((hostId) => ({
      async connect(page: Page) {
        await page.routeWebSocket("**/v1/restore/*", (socket) => {
          if (new URL(socket.url()).pathname.endsWith(`/${hostId}`)) socket.connectToServer();
          else socket.close({ code: 4404, reason: "partitioned" });
        });
      },
      async records(): Promise<Signed[]> {
        return await (await fetch(new URL(`/snapshot/${hostId}`, info.url))).json();
      },
    }));
    return { ...info, holders, locator: Uint8Array.from(info.locator), clean };
  } catch (error) {
    await clean();
    throw error;
  }
}

export function restoredMemberships() {
  const old = browserMeshFixture();
  const observer = generateHostIdentity();
  const fresh = generateHostIdentity();
  const { meshId: mesh, records, signPub: oldKey } = old.membership;
  const parent = records.at(-1);
  if (parent === undefined) throw new Error("missing fixture join");
  const a = old.holder;
  const by = pub(a);
  const card = signCard(
    cardBodyFor(
      { ...observer, noisePub: observer.noise.publicKey },
      { name: "observer", hcId: "", devicePub: noise(observer) },
      { mesh, inviter: by, kind: "client" },
    ),
    observer.sign.secretKey,
  );
  const join = signRecord(
    { v: 2, mesh, type: "admit", by, n: 4, prev: [hashOf(parent)], subject: { card } },
    a.sign.secretKey,
  );
  const proof = {
    old: oldKey,
    signPub: pub(fresh),
    noise: noise(fresh),
    name: "my-browser",
    at,
    nonce: base64urlEncode(new Uint8Array(16).fill(9)),
  };
  const restore = signRecord(
    {
      v: 3,
      mesh,
      by,
      n: 5,
      prev: [hashOf(join)],
      type: "readmit",
      subject: {
        ...proof,
        oldSig: signReadmit(mesh, proof, old.browser.sign.secretKey),
        newSig: signReadmit(mesh, proof, fresh.sign.secretKey),
        approval: { by: pub(observer), sig: approveReadmit(mesh, proof, observer.sign.secretKey) },
      },
    },
    a.sign.secretKey,
  );
  const membership = { ...old.membership, records: [...records, join, restore] };
  return {
    old: { ...old, membership },
    observer: {
      ...old,
      membership: { ...membership, signPub: pub(observer) },
      cardSecret: [...observer.sign.secretKey],
      deviceSecret: [...observer.noise.secretKey],
    },
  };
}
