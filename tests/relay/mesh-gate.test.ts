import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect, gate, isRequired } from "./support/mesh/capabilities.ts";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratchRoot(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "mgate-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A `packages/mesh` that exports every function the scenarios use, except that `hashOf` was renamed. */
const RENAMED_EXPORT = ["signRecord", "signCard", "hashOfRecord", "meshIdOf", "verifyCard", "viewOf"].map(
  (name) => `export function ${name}() { return undefined; }`,
);

describe("mesh e2e gating", () => {
  test("with no mesh artifact on the branch, a missing capability is skipped, and DORIFACE_MESH_E2E=require makes it fail", async () => {
    const root = scratchRoot({});
    const present = await detect(root);
    expect(present.records.works).toBe(false);
    expect(isRequired(root, undefined)).toBe(false);
    expect(gate(present, ["records"], isRequired(root, undefined)).kind).toBe("skip");
    expect(isRequired(root, "require")).toBe(true);
    expect(gate(present, ["records"], isRequired(root, "require")).kind).toBe("fail");
  });

  test("a packages/mesh that is present but broken (hashOf renamed) fails the run instead of skipping it", async () => {
    const root = scratchRoot({ "packages/mesh/src/index.ts": `${RENAMED_EXPORT.join("\n")}\n` });
    const present = await detect(root);
    expect(present.records.works).toBe(false);
    expect(isRequired(root, undefined)).toBe(true);
    expect(gate(present, ["records"], isRequired(root, undefined)).kind).toBe("fail");
  });
});
