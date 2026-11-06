import { describe, expect, test } from "bun:test";
import { buildPairingUrl, hostIdOf } from "@doriface/crypto";
import { deepLinkArg, parseDeepLink, parseInAppLink } from "../src/config/deep-link.ts";

const signPub = new Uint8Array(32).map((_, index) => (index * 37 + 11) % 256);
const LINK = buildPairingUrl({
  webOrigin: "https://app.doriterm.com",
  hostId: hostIdOf(signPub),
  noiseStaticPub: new Uint8Array(32).map((_, index) => (index * 53 + 7) % 256),
  signPub,
  linkSecret: new Uint8Array(32).fill(7),
  relayUrl: "wss://relay.invalid",
});
const FRAGMENT = LINK.slice(LINK.indexOf("#"));
const params = new URLSearchParams(FRAGMENT.slice(1));
const fragmentWith = (key: string, value: string): string => {
  const next = new URLSearchParams(params);
  next.set(key, value);
  return `#${next.toString()}`;
};

describe("parseDeepLink", () => {
  test("takes doriface://pair with the pairing link's fragment, re-serialized", () => {
    const pair = { kind: "pair", fragment: FRAGMENT } as const;
    expect(parseDeepLink(`doriface://pair${FRAGMENT}`)).toEqual(pair);
    expect(parseDeepLink(`doriface://pair/${FRAGMENT}`)).toEqual(pair);
    const relayUnescaped = `doriface://pair#${FRAGMENT.slice(1).replace("wss%3A%2F%2F", "wss://")}`;
    expect(parseDeepLink(relayUnescaped)).toEqual(pair);
  });

  test("takes a bare doriface:// as a request to bring the app forward", () => {
    expect(parseDeepLink("doriface://")).toEqual({ kind: "open" });
    expect(parseDeepLink("doriface:///")).toEqual({ kind: "open" });
  });

  test.each([
    ["another route", `doriface://settings${FRAGMENT}`],
    ["a route in the path", `doriface:///pair${FRAGMENT}`],
    ["an opaque route", `doriface:pair${FRAGMENT}`],
    ["a deeper path", `doriface://pair/x${FRAGMENT}`],
    ["a query", `doriface://pair?p=x${FRAGMENT}`],
    ["credentials", `doriface://user@pair${FRAGMENT}`],
    ["a port", `doriface://pair:1${FRAGMENT}`],
    ["an upper-case route", `doriface://PAIR${FRAGMENT}`],
    ["no fragment", "doriface://pair"],
    ["a fragment on the open route", `doriface://${FRAGMENT}`],
    ["an unknown key", `doriface://pair${FRAGMENT}&x=1`],
    ["a repeated key", `doriface://pair${FRAGMENT}&p=${params.get("p") ?? ""}`],
    ["an older host's code", `doriface://pair${FRAGMENT}&c=ABCDEFGH`],
    ["a missing key", `doriface://pair#${FRAGMENT.slice(1).replace(/&r=[^&]*/, "")}`],
    ["a short link secret", `doriface://pair${fragmentWith("p", "A".repeat(42))}`],
    ["a hostId of another key", `doriface://pair${fragmentWith("h", "a".repeat(26))}`],
    ["a relay that is not a WebSocket", `doriface://pair${fragmentWith("r", "file:///etc/passwd")}`],
    ["another scheme", `https://pair${FRAGMENT}`],
    ["an oversized link", `doriface://pair${FRAGMENT}${"&".repeat(4096)}`],
    ["not a URL", "doriface"],
  ])("refuses %s", (_name, candidate) => {
    expect(parseDeepLink(candidate)).toBeUndefined();
  });

  test("refuses anything that is not a string", () => {
    for (const candidate of [undefined, null, 42, {}, [`doriface://pair${FRAGMENT}`]]) {
      expect(parseDeepLink(candidate)).toBeUndefined();
    }
  });
});

describe("parseInAppLink", () => {
  test("keeps the web app's pairing link in the app", () => {
    expect(parseInAppLink(LINK)).toEqual({ kind: "pair", fragment: FRAGMENT });
  });

  test("keeps a link printed on the previous host, while that host is still live", () => {
    expect(parseInAppLink(LINK.replace("app.doriterm.com", "doriface.omo.dev"))).toEqual({
      kind: "pair",
      fragment: FRAGMENT,
    });
  });

  test.each([
    ["another origin", LINK.replace("app.doriterm.com", "evil.omo.dev")],
    ["a host ending in the web app's host", LINK.replace("app.doriterm.com", "evil-app.doriterm.com")],
    ["a subdomain of the web app's host", LINK.replace("app.doriterm.com", "x.app.doriterm.com")],
    ["a host starting with the web app's host", LINK.replace("app.doriterm.com", "app.doriterm.com.evil.com")],
    ["plain http", LINK.replace("https:", "http:")],
    ["a port", LINK.replace("app.doriterm.com", "app.doriterm.com:8443")],
    ["credentials", LINK.replace("https://", "https://user@")],
    ["another path", LINK.replace("/pair#", "/pair/#")],
    ["a query", LINK.replace("/pair#", "/pair?x=1#")],
    ["a bad fragment", LINK.replace(/&r=[^&]*/, "")],
    ["a doriface: link", `doriface://pair${FRAGMENT}`],
    ["an ordinary allowlisted link", "https://github.com/sisyphuslabs/doriterm"],
  ])("leaves %s to the browser rules", (_name, candidate) => {
    expect(parseInAppLink(candidate)).toBeUndefined();
  });
});

describe("deepLinkArg", () => {
  test("finds the one doriface: argument a launch carries", () => {
    const link = `doriface://pair${FRAGMENT}`;
    expect(deepLinkArg(["/Applications/doriface", "--flag", link])).toBe(link);
    expect(deepLinkArg(["/Applications/doriface", "DORIFACE://pair"])).toBe("DORIFACE://pair");
    expect(deepLinkArg(["/Applications/doriface", "--user-data-dir=/x"])).toBeUndefined();
  });

  test("ignores a launch that carries more than one", () => {
    expect(deepLinkArg(["app", "doriface://", `doriface://pair${FRAGMENT}`])).toBeUndefined();
  });
});
