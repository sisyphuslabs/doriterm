import { describe, expect, test } from "bun:test";
import {
  DEVICE_LINK_REFUSAL,
  HOST_TARGET_REFUSAL,
  inviteKindOf,
  JoinRefused,
  meshInviteOf,
} from "../src/join/index.ts";

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof JoinRefused) return error.message;
    throw error;
  }
  return "admitted";
};

describe("what the shared joiner may be started from (#1386)", () => {
  test("a device pairing link is refused before anything is dialed, in the host's words", () => {
    expect(refusal(() => meshInviteOf({ kind: "link", mesh: false }))).toBe(DEVICE_LINK_REFUSAL);
    expect(DEVICE_LINK_REFUSAL).toBe("this link pairs a device: run doriface-host mesh pair on the member");
  });

  test("a bare hostId is refused: a join takes an invite, never an address", () => {
    expect(refusal(() => meshInviteOf({ kind: "host" }))).toBe(HOST_TARGET_REFUSAL);
    expect(HOST_TARGET_REFUSAL).toBe("mesh join takes a mesh pairing link or code, not a hostId");
  });

  test("a mesh link (`m=1`) is admitted and says it was a link", () => {
    expect(inviteKindOf(meshInviteOf({ kind: "link", mesh: true }))).toBe("link");
  });

  test("a typed code is admitted and says it was a code: its offer's kind is the inviter's to judge", () => {
    expect(inviteKindOf(meshInviteOf({ kind: "code" }))).toBe("code");
  });
});
