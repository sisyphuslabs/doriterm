import { describe, expect, test } from "bun:test";
import { checkNamespace, type ChainFolder, TRUSTED_INSTALLER_SID } from "./namespace.ts";
import { parseSddl } from "./sddl.ts";

const USER = "S-1-5-21-1000-2000-3000-1001";
const OTHER = "S-1-5-21-1000-2000-3000-1002";
const lookupGroup = () => ({ status: "resolved" as const, name: "State editors", domain: "PC", use: 4 });
const folder = (path: string, sddl: string, reparsePoint = false): ChainFolder => ({
  path,
  descriptor: parseSddl(sddl),
  reparsePoint,
});

/** A standard Windows profile chain, from the state folder up to C:\. */
const PROFILE_CHAIN = [
  folder("C:\\Users\\q\\.local\\state\\doriface-host", `O:${USER}D:P(A;OICI;FA;;;${USER})`),
  folder("C:\\Users\\q\\.local\\state", `O:${USER}D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`),
  folder("C:\\Users\\q\\.local", `O:${USER}D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`),
  folder("C:\\Users\\q", `O:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`),
  folder("C:\\Users", `O:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;OICI;0x1200a9;;;WD)`),
  folder(
    "C:\\",
    `O:${TRUSTED_INSTALLER_SID}D:P(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)(A;;0x4;;;AU)(A;OICIIO;0x1301bf;;;AU)`,
  ),
];

describe("checkNamespace (#406 design revision 3.2)", () => {
  test("N6 the standard profile chain is trusted", () => {
    expect(checkNamespace(PROFILE_CHAIN, USER)).toEqual({ verdict: "trusted" });
  });

  for (const [name, rights] of [
    ["N1 WRITE_DAC", "WD"],
    ["N1 WRITE_OWNER", "WO"],
    ["N1 DELETE", "SD"],
    ["N1 FILE_DELETE_CHILD", "DT"],
    ["N2 GENERIC_ALL", "GA"],
    ["N2 GENERIC_WRITE", "GW"],
    ["N2 a hex mask with FILE_DELETE_CHILD", "0x40"],
  ] as const) {
    test(`${name} granted to another account on the parent is untrusted`, () => {
      const chain = [PROFILE_CHAIN[0], folder("D:\\shared", `O:${USER}D:P(A;;FA;;;${USER})(A;;${rights};;;${OTHER})`)];
      expect(
        checkNamespace(
          chain.filter((entry) => entry !== undefined),
          USER,
        ),
      ).toMatchObject({
        verdict: "untrusted",
        path: "D:\\shared",
      });
    });
  }

  test("N3 a folder owned by another account is untrusted", () => {
    const chain = [folder("D:\\theirs", `O:${OTHER}D:P(A;;FA;;;${USER})`)];
    expect(checkNamespace(chain, USER)).toMatchObject({ verdict: "untrusted", path: "D:\\theirs" });
  });

  test("N4 an inherit-only grant does not apply to the folder itself", () => {
    const chain = [folder("D:\\x", `O:${USER}D:P(A;;FA;;;${USER})(A;OICIIO;FA;;;${OTHER})`)];
    expect(checkNamespace(chain, USER)).toEqual({ verdict: "trusted" });
  });

  test("N5 a reparse point anywhere in the chain is untrusted", () => {
    const chain = PROFILE_CHAIN.map((entry, index) =>
      index === 2 ? Object.assign({}, entry, { reparsePoint: true }) : entry,
    );
    expect(checkNamespace(chain, USER)).toMatchObject({ verdict: "untrusted", path: "C:\\Users\\q\\.local" });
  });

  test("read and create-subfolder rights for others are not namespace rights", () => {
    const chain = [folder("D:\\x", `O:${USER}D:P(A;;FA;;;${USER})(A;;0x1200a9;;;BU)(A;;0x4;;;AU)`)];
    expect(checkNamespace(chain, USER)).toEqual({ verdict: "trusted" });
  });
});

describe("actionable namespace refusal (#1299)", () => {
  const inherited = folder("D:\\shared\\state", `O:${USER}D:(A;CIID;GW;;;${OTHER})`);
  const explicit = folder("D:\\shared", `O:${USER}D:(A;CI;GW;;;${OTHER})`);

  test("reports the explicit ancestor, not the leaf carrying an inherited copy", () => {
    expect(checkNamespace([inherited, explicit], USER)).toMatchObject({
      verdict: "untrusted",
      path: explicit.path,
    });
  });

  test("traces multiple inherited copies but leaves an explicit leaf grant on the leaf", () => {
    const leaf = folder("D:\\shared\\middle\\state", `O:${USER}D:(A;CIID;GW;;;${OTHER})`);
    const middle = folder("D:\\shared\\middle", `O:${USER}D:(A;CIID;GW;;;${OTHER})`);
    expect(checkNamespace([leaf, middle, explicit], USER)).toMatchObject({ path: explicit.path });
    const ownGrant = folder(leaf.path, `O:${USER}D:(A;CI;GW;;;${OTHER})`);
    expect(checkNamespace([ownGrant, middle, explicit], USER)).toMatchObject({ path: leaf.path });
  });

  test("does not follow stale inherited flags through a protected DACL", () => {
    const protectedLeaf = folder(inherited.path, `O:${USER}D:P(A;CIID;GW;;;${OTHER})`);
    expect(checkNamespace([protectedLeaf, explicit], USER)).toMatchObject({ path: protectedLeaf.path });
  });

  test("finds the source of a one-generation no-propagate grant", () => {
    const child = folder(inherited.path, `O:${USER}D:(A;ID;GW;;;${OTHER})`);
    const parent = folder(explicit.path, `O:${USER}D:(A;CINP;GW;;;${OTHER})`);
    expect(checkNamespace([child, parent], USER)).toMatchObject({ path: parent.path });
  });

  test("traces a drive root's inherit-only generic grant to its mapped copy on the child", () => {
    // The default ACL of a non-system drive root and the two ACEs Windows writes on a new folder below it. The AU
    // ACEs come first so that this test covers only the tracing: the grant search stops at the first namespace grant.
    const root = folder("D:\\", "O:BAD:(A;OICIIO;SDGXGWGR;;;AU)(A;;0x4;;;AU)(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)");
    const app = folder(
      "D:\\app",
      `O:${USER}D:(A;ID;0x1301bf;;;AU)(A;OICIIOID;SDGXGWGR;;;AU)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)`,
    );
    const verdict = checkNamespace([app, root], USER);
    expect(verdict).toMatchObject({ verdict: "untrusted", path: root.path });
    expect(verdict).toMatchObject({
      message: expect.stringContaining('Remove the ACE granting those rights on "D:\\"'),
    });
  });

  test("traces a parent's GENERIC_ALL grant to the FILE_ALL_ACCESS copy on the child", () => {
    const child = folder(inherited.path, `O:${USER}D:(A;ID;FA;;;${OTHER})(A;OICIIOID;GA;;;${OTHER})`);
    const parent = folder(explicit.path, `O:${USER}D:(A;OICI;GA;;;${OTHER})`);
    expect(checkNamespace([child, parent], USER)).toMatchObject({ verdict: "untrusted", path: parent.path });
  });

  test("an inherited grant whose source is not found is reported as inherited, not as removable there", () => {
    const boundary = folder("D:\\shared\\middle", `O:${USER}D:P(A;;FA;;;${USER})`);
    const verdict = checkNamespace([inherited, boundary], USER);
    if (verdict.verdict !== "untrusted") throw new Error("expected refusal");
    expect(verdict.path).toBe(inherited.path);
    expect(verdict.message).not.toContain("Remove the ACE");
    expect(verdict.message).toContain(`inherited`);
    expect(verdict.message).toContain(`disable inheritance on "${inherited.path}"`);
  });

  test("trusted ACLs never need an account-name lookup", () => {
    expect(
      checkNamespace(PROFILE_CHAIN, USER, () => {
        throw new Error("display lookup must not run for a trusted namespace");
      }),
    ).toEqual({ verdict: "trusted" });
  });

  test("does not attribute an inherited grant to an unrelated ACE above an inheritance boundary", () => {
    const boundary = folder("D:\\shared\\middle", `O:${USER}D:P(A;;FA;;;${USER})`);
    expect(checkNamespace([inherited, boundary, explicit], USER)).toMatchObject({
      verdict: "untrusted",
      path: inherited.path,
    });
  });

  test("names a resolved local group and describes both remedies and the parent check", () => {
    const verdict = checkNamespace([inherited, explicit], USER, lookupGroup);
    if (verdict.verdict !== "untrusted") throw new Error("expected refusal");
    expect(verdict.message).toContain("parent folders");
    expect(verdict.message).toContain(`Remove the ACE granting those rights on "${explicit.path}"`);
    expect(verdict.message).toContain("only you and SYSTEM/Administrators can modify");
    expect(verdict).toMatchObject({
      verdict: "untrusted",
      path: explicit.path,
      reason: expect.stringContaining("a local group named PC\\State editors"),
      message: expect.stringContaining("DORIFACE_HOST_STATE_DIR"),
    });
  });

  test("explains an unmapped SID instead of printing only its number", () => {
    expect(checkNamespace([explicit], USER, () => ({ status: "unmapped" }))).toMatchObject({
      verdict: "untrusted",
      reason: expect.stringContaining(`an account that no longer exists (SID ${OTHER})`),
    });
  });

  test("does not call a failed lookup a deleted account, and still refuses", () => {
    expect(checkNamespace([explicit], USER, () => ({ status: "unavailable", code: 1722 }))).toMatchObject({
      verdict: "untrusted",
      reason: expect.stringContaining(`an account Windows could not resolve (SID ${OTHER}; error 1722)`),
    });
  });

  test("names an untrusted owner without changing that refusal", () => {
    const owned = folder("D:\\theirs", `O:${OTHER}D:P(A;;FA;;;${USER})`);
    expect(
      checkNamespace([owned], USER, () => ({ status: "resolved", name: "Other", domain: "PC", use: 1 })),
    ).toMatchObject({
      verdict: "untrusted",
      path: owned.path,
      reason: "it is owned by a user account named PC\\Other",
    });
  });
});
