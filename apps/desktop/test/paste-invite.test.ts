import { describe, expect, test } from "bun:test";
import { buildPairingDeepLink, buildPairingUrl, hostIdOf } from "@doriface/crypto";
import { inviteLink } from "../src/config/invite-link.ts";
import { GESTURE_MS, InputGestures, pasteInvite } from "../src/main/paste-invite.ts";

const signPub = new Uint8Array(32).map((_, index) => (index * 37 + 11) % 256);
const keys = {
  hostId: hostIdOf(signPub),
  noiseStaticPub: new Uint8Array(32).map((_, index) => (index * 53 + 7) % 256),
  signPub,
  linkSecret: new Uint8Array(32).fill(7),
  relayUrl: "wss://relay.invalid",
  mesh: true,
};
const WEB_INVITE = buildPairingUrl({ ...keys, webOrigin: "https://app.doriterm.com" });
const INVITE = buildPairingDeepLink(keys);
const PAGE = 7;

/** A page whose clipboard holds `text`, counting every read the shell makes of it. */
const page = (text: string, gestures = new InputGestures()) => {
  let reads = 0;
  const deps = {
    takeGesture: (contentsId: number) => gestures.take(contentsId),
    readClipboard: async () => {
      reads += 1;
      return text;
    },
  };
  return { gestures, deps, reads: () => reads };
};

describe("Paste invite (#2656)", () => {
  test("a click just before reads the clipboard's invite link and answers it rebuilt", async () => {
    const { gestures, deps, reads } = page(`  ${WEB_INVITE}\n`);
    gestures.note(PAGE, "mouseUp");
    expect(await pasteInvite(PAGE, deps)).toEqual({ link: INVITE });
    expect(reads()).toBe(1);
  });

  test("a clipboard without an invite link answers none of its text", async () => {
    const texts = [
      "hunter2-password",
      "ABCD1234",
      "https://example.com/pair",
      `see ${WEB_INVITE}`,
      `${WEB_INVITE}?x=1`,
    ];
    const answers = await Promise.all(
      texts.map((text) => {
        const { gestures, deps } = page(text);
        gestures.note(PAGE, "keyDown");
        return pasteInvite(PAGE, deps);
      }),
    );
    expect(answers).toEqual(texts.map(() => ({ refused: "not-invite" })));
  });

  test("without a gesture the clipboard is not read at all", async () => {
    const { gestures, deps, reads } = page(WEB_INVITE);
    expect(await pasteInvite(PAGE, deps)).toEqual({ refused: "gesture" });
    gestures.note(PAGE, "mouseMove");
    gestures.note(PAGE + 1, "mouseUp");
    expect(await pasteInvite(PAGE, deps)).toEqual({ refused: "gesture" });
    expect(await pasteInvite(undefined, deps)).toEqual({ refused: "gesture" });
    expect(reads()).toBe(0);
  });

  test("one gesture reads once, and only within its window", async () => {
    let now = 1_000;
    const { gestures, deps, reads } = page(WEB_INVITE, new InputGestures(() => now));
    gestures.note(PAGE, "mouseDown");
    expect(await pasteInvite(PAGE, deps)).toEqual({ link: INVITE });
    expect(await pasteInvite(PAGE, deps)).toEqual({ refused: "gesture" });
    gestures.note(PAGE, "mouseDown");
    now += GESTURE_MS + 1;
    expect(await pasteInvite(PAGE, deps)).toEqual({ refused: "gesture" });
    expect(reads()).toBe(1);
  });
});

describe("inviteLink", () => {
  test("takes both forms of a pairing link and rebuilds them as the deep link", () => {
    expect(inviteLink(WEB_INVITE)).toBe(INVITE);
    expect(inviteLink(INVITE)).toBe(INVITE);
    expect(inviteLink(buildPairingDeepLink({ ...keys, mesh: false }))).toBe(
      buildPairingDeepLink({ ...keys, mesh: false }),
    );
  });

  test("refuses anything that is not exactly an invite link", () => {
    const hash = WEB_INVITE.slice(WEB_INVITE.indexOf("#"));
    const refused = [
      "",
      "ABCD-1234",
      `https://app.doriterm.com/other${hash}`,
      `https://user:pw@app.doriterm.com/pair${hash}`,
      `javascript://pair${hash}`,
      `${WEB_INVITE} ${WEB_INVITE}`,
      WEB_INVITE.replace(keys.hostId, "a".repeat(26)),
      WEB_INVITE.replace("m=1", "m=2"),
      `${WEB_INVITE}&h=${keys.hostId}`,
      `${WEB_INVITE}&pad=${"x".repeat(2048)}`,
    ];
    for (const text of refused) expect(inviteLink(text)).toBeUndefined();
  });
});
