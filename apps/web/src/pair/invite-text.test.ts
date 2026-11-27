import { expect, test } from "bun:test";
import { linkTarget } from "./fragment.ts";
import { CloseCode } from "@doriface/relay-client";
import { pairingFailureReason } from "./handshake.ts";
import { inviteIn, isOwnInvite } from "./invite-text.ts";

const LINK = "doriface://pair#h=host&k=key&s=sig&p=secret&r=wss://relay.example&m=1";
const FRAGMENT = LINK.slice(LINK.indexOf("#"));

test.each([
  ["the bare link", LINK],
  ["the whole install line", `curl -fsSL https://get.doriterm.com | DORIFACE_JOIN='<${LINK}>' sh`],
  ["the install line without angle brackets", `curl -fsSL https://get.doriterm.com | DORIFACE_JOIN='${LINK}' sh`],
  ["the link with spaces around it", `  ${LINK}\n`],
])("%s gives the invite's fragment, and a mesh invite stays a mesh invite", (_name, pasted) => {
  expect(inviteIn(pasted)).toBe(FRAGMENT);
  expect(linkTarget(inviteIn(pasted))).toBe("mesh");
});

test("a typed code has no fragment and is passed on as typed, trimmed", () => {
  expect(inviteIn(" ABCD 2345 ")).toBe("ABCD 2345");
});

test.each([
  ["the selected host", { hostId: "host", members: [] }, true],
  ["a roster member", { hostId: "other", members: [{ hostId: "host" }] }, true],
  ["a host this app does not reach", { hostId: "other", members: [{ hostId: "third" }] }, false],
  ["an app with no host yet", { hostId: "", members: [] }, false],
])("an invite from %s is this app's own: %p", (_name, known, own) => {
  expect(isOwnInvite("host", known)).toBe(own);
});

// Q, 2026-11-27: on an iPhone Home Screen app, a tapped invite opens in Safari, which pairs and spends it.
test("a link refused as used names the Safari cause only in an installed iPhone app", () => {
  const onPhone = pairingFailureReason("link", CloseCode.UnknownDevice, true) ?? "";
  const elsewhere = pairingFailureReason("link", CloseCode.UnknownDevice, false) ?? "";
  expect(onPhone.startsWith(elsewhere)).toBe(true);
  expect(onPhone.length).toBeGreaterThan(elsewhere.length);
  expect(pairingFailureReason("code", CloseCode.UnknownDevice, true)).toBe(
    pairingFailureReason("code", CloseCode.UnknownDevice, false),
  );
});
