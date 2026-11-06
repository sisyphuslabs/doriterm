import { base64urlEncode, buildPairingUrl, DEFAULT_RELAY_URL, formatPairingCode } from "@doriface/crypto";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderUnicodeCompact } from "uqr";
import { listenControl } from "../control.ts";
import { loadHostIdentity } from "../state/host-keys.ts";
import { PairingStore, pendingToWire } from "../state/pairing.ts";
import { meshJoinCommand } from "./mesh-join.ts";
import { pairCommand } from "./pair.ts";

function linkOf(text: string, prefix: string): string {
  const line = text.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) throw new Error(`no ${prefix} link in:\n${text}`);
  return line;
}

const fragmentOf = (link: string): URLSearchParams => new URLSearchParams(new URL(link).hash.slice(1));

const withStateDir = async (name: string, run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), name));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("doriface-host pair", () => {
  test("prints the desktop app's deep link by default, never the dead web origin", async () => {
    await withStateDir("dh-pair-", async (dir) => {
      let text = "";
      await pairCommand(["--no-qr", "--state-dir", dir], (chunk) => void (text += chunk));
      expect(text).not.toContain("https://doriface.omo.dev");
      expect(text.split("\n").filter((line) => line.startsWith("http"))).toEqual([]);
      expect(text).toContain("Doriterm desktop app");
      const link = linkOf(text, "doriface://pair#");
      expect([...fragmentOf(link).keys()]).toEqual(["h", "k", "s", "p", "r"]);
      const offer = new PairingStore(dir).read();
      if (offer === undefined) throw new Error("pair printed a link but stored no offer");
      expect(fragmentOf(link).get("p")).toBe(base64urlEncode(offer.linkSecret));
      expect(text).toContain(formatPairingCode(offer.code));
    });
  });

  test("the QR code is the hosted web app's /pair page for a phone, while the printed link stays the deep link", async () => {
    await withStateDir("dh-pair-qr-", async (dir) => {
      let text = "";
      await pairCommand(["--state-dir", dir], (chunk) => void (text += chunk));
      const identity = loadHostIdentity(dir);
      const offer = new PairingStore(dir).read();
      if (offer === undefined) throw new Error("pair printed a QR code but stored no offer");
      const phone = buildPairingUrl({
        webOrigin: "https://doriface.omo.dev",
        hostId: identity.hostId,
        noiseStaticPub: identity.noise.publicKey,
        signPub: identity.sign.publicKey,
        linkSecret: offer.linkSecret,
        relayUrl: DEFAULT_RELAY_URL,
      });
      expect(text).toContain(renderUnicodeCompact(phone, { ecc: "L", border: 2 }));
      expect(new URL(linkOf(text, "doriface://pair#")).hash).toBe(new URL(phone).hash);
    });
  });

  test("--web-origin still prints that origin's pairing page, and says it opens in a browser", async () => {
    await withStateDir("dh-pair-web-", async (dir) => {
      let text = "";
      await pairCommand(["--no-qr", "--web-origin", "https://web.example", "--state-dir", dir], (chunk) => {
        text += chunk;
      });
      const link = linkOf(text, "https://web.example/pair#");
      expect([...fragmentOf(link).keys()]).toEqual(["h", "k", "s", "p", "r"]);
      expect(text).not.toContain("doriface://pair#");
      expect(text).not.toContain("https://doriface.omo.dev");
      expect(text).toContain("browser");
    });
  });
});

describe("doriface-host mesh pair", () => {
  test("prints a deep link the joining machine can hand to mesh join, never the dead web origin", async () => {
    await withStateDir("dh-mesh-pair-", async (dir) => {
      const offer = new PairingStore(dir).offer(Date.now(), true);
      const control = listenControl(dir, () => Promise.resolve(pendingToWire(offer)));
      let text = "";
      try {
        await meshJoinCommand(
          ["pair", "--auto", "--no-qr", "--state-dir", dir],
          (chunk) => void (text += chunk),
          () => {},
        );
      } finally {
        control.stop();
      }
      expect(text).not.toContain("https://doriface.omo.dev");
      const link = linkOf(text, "doriface://pair#");
      const fragment = fragmentOf(link);
      expect([...fragment.keys()]).toEqual(["h", "k", "s", "p", "r", "m"]);
      expect(fragment.get("p")).toBe(base64urlEncode(offer.linkSecret));
      expect(fragment.get("m")).toBe("1");
      expect(text).toContain("mesh join");
    });
  });

  test("--web-origin still prints that origin's page, with the mesh flag", async () => {
    await withStateDir("dh-mesh-pair-web-", async (dir) => {
      const offer = new PairingStore(dir).offer(Date.now(), true);
      const control = listenControl(dir, () => Promise.resolve(pendingToWire(offer)));
      let text = "";
      try {
        await meshJoinCommand(
          ["pair", "--auto", "--no-qr", "--web-origin", "https://web.example", "--state-dir", dir],
          (chunk) => void (text += chunk),
          () => {},
        );
      } finally {
        control.stop();
      }
      const link = linkOf(text, "https://web.example/pair#");
      expect(fragmentOf(link).get("m")).toBe("1");
      expect(text).not.toContain("doriface://pair#");
      expect(text).not.toContain("https://doriface.omo.dev");
    });
  });
});

async function withOfferElsewhere(): Promise<ReturnType<PairingStore["offer"]>> {
  let offer: ReturnType<PairingStore["offer"]> | undefined;
  await withStateDir("dh-pair-offer-", async (dir) => {
    offer = new PairingStore(dir).offer(Date.now());
  });
  if (offer === undefined) throw new Error("no offer");
  return offer;
}

describe("doriface-host pair --wait-host", () => {
  test("refuses, and opens no offer, when no running host answers in time", async () => {
    await withStateDir("dh-pair-wait-none-", async (dir) => {
      await expect(pairCommand(["--no-qr", "--state-dir", dir, "--wait-host", "0.5"], () => {})).rejects.toThrow(
        /no running doriface-host answered/,
      );
      expect(new PairingStore(dir).read()).toBeUndefined();
    });
  });

  test("waits for a host that starts after it, then prints that host's offer", async () => {
    await withStateDir("dh-pair-wait-late-", async (dir) => {
      // The offer the late host answers with; made elsewhere, so this state dir holds none pair could print instead.
      const offer = await withOfferElsewhere();
      let control: ReturnType<typeof listenControl> | undefined;
      let text = "";
      try {
        await pairCommand(["--no-qr", "--state-dir", dir, "--wait-host", "10"], (chunk) => {
          text += chunk;
          // The host starts only once pair says it is waiting, so the offer can only come from the waited-for host.
          if (control === undefined && text.includes("Waiting for doriface-host"))
            control = listenControl(dir, () => Promise.resolve(pendingToWire(offer)));
        });
      } finally {
        control?.stop();
      }
      expect(control).toBeDefined();
      const link = linkOf(text, "doriface://pair#");
      expect(fragmentOf(link).get("p")).toBe(base64urlEncode(offer.linkSecret));
    });
  });

  test("waits for the relay to register the code, so the printed code works on its first try", async () => {
    await withStateDir("dh-pair-wait-slot-", async (dir) => {
      const offer = new PairingStore(dir).offer(Date.now());
      const control = listenControl(dir, () => Promise.resolve(pendingToWire(offer)));
      let text = "";
      let registered = false;
      try {
        await pairCommand(["--no-qr", "--state-dir", dir, "--wait-host", "10"], (chunk) => {
          text += chunk;
          if (!registered && text.includes("Waiting for the relay")) {
            registered = true;
            new PairingStore(dir).setSlot(offer.code, "registered");
          }
        });
      } finally {
        control.stop();
      }
      expect(registered).toBe(true);
      const codeLine = text.split("\n").find((line) => line.startsWith("code "));
      expect(codeLine).toBe(`code        ${formatPairingCode(offer.code)}`);
    });
  });

  test("rejects a wait that is not a positive number of seconds", async () => {
    await withStateDir("dh-pair-wait-bad-", async (dir) => {
      await expect(pairCommand(["--no-qr", "--state-dir", dir, "--wait-host", "soon"], () => {})).rejects.toThrow(
        /--wait-host wants a positive number of seconds/,
      );
    });
  });
});
