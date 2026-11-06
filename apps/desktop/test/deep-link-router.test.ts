import { afterEach, describe, expect, test } from "bun:test";
import { base64urlEncode, buildPairingUrl, hostIdOf } from "@doriface/crypto";
import { openDeepLink, openInAppLink, routeDeepLinksTo, takePairingLink } from "../src/main/deep-link.ts";
import { Channel } from "../src/shared/bridge.ts";

const signPub = new Uint8Array(32).map((_, index) => (index * 37 + 11) % 256);
const linkFor = (fill: number): string =>
  buildPairingUrl({
    webOrigin: "https://app.doriterm.com",
    hostId: hostIdOf(signPub),
    noiseStaticPub: new Uint8Array(32).fill(5),
    signPub,
    linkSecret: new Uint8Array(32).fill(fill),
    relayUrl: "wss://relay.invalid",
  });
const fragmentOf = (link: string): string => link.slice(link.indexOf("#"));

function recordingWindow() {
  const sent: string[] = [];
  let reveals = 0;
  routeDeepLinksTo(() => {
    reveals += 1;
    return { send: (channel: string) => void sent.push(channel) };
  });
  return { sent, reveals: () => reveals };
}

afterEach(() => {
  takePairingLink();
  routeDeepLinksTo(() => undefined);
});

describe("the main process deep-link router", () => {
  test("a doriface://pair link brings the window forward and leaves the secret for its renderer to take", () => {
    const shown = recordingWindow();
    const link = linkFor(1);
    openDeepLink(`doriface://pair${fragmentOf(link)}`);
    expect(shown.reveals()).toBe(1);
    expect(shown.sent).toEqual([Channel.pairingLinkWaiting]);
    expect(takePairingLink()).toBe(fragmentOf(link));
    expect(takePairingLink()).toBeUndefined();
  });

  test("the newest link wins while the renderer has not taken one", () => {
    recordingWindow();
    openDeepLink(`doriface://pair${fragmentOf(linkFor(1))}`);
    openDeepLink(`doriface://pair${fragmentOf(linkFor(2))}`);
    expect(takePairingLink()).toBe(fragmentOf(linkFor(2)));
  });

  test("a link that comes before the window exists waits for it", () => {
    routeDeepLinksTo(() => undefined);
    openDeepLink(`doriface://pair${fragmentOf(linkFor(3))}`);
    expect(takePairingLink()).toBe(fragmentOf(linkFor(3)));
  });

  test("a bare doriface:// only brings the window forward", () => {
    const shown = recordingWindow();
    openDeepLink("doriface://");
    expect(shown.reveals()).toBe(1);
    expect(shown.sent).toEqual([]);
    expect(takePairingLink()).toBeUndefined();
  });

  test("a refused link neither shows the window nor reaches the renderer", () => {
    const shown = recordingWindow();
    const secret = base64urlEncode(new Uint8Array(32).fill(4));
    for (const candidate of [`doriface://settings${fragmentOf(linkFor(4))}`, `doriface://pair?p=${secret}`, "x"]) {
      openDeepLink(candidate);
    }
    expect(shown.reveals()).toBe(0);
    expect(shown.sent).toEqual([]);
    expect(takePairingLink()).toBeUndefined();
  });

  test("a pairing link clicked in the app stays in the app; any other link is left to the browser rules", () => {
    const shown = recordingWindow();
    const link = linkFor(6);
    expect(openInAppLink(link)).toBe(true);
    expect(takePairingLink()).toBe(fragmentOf(link));
    expect(openInAppLink("https://github.com/sisyphuslabs/doriterm")).toBe(false);
    expect(openInAppLink(`doriface://pair${fragmentOf(link)}`)).toBe(false);
    expect(shown.reveals()).toBe(1);
  });
});
