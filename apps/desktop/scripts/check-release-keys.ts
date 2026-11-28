import { RELEASE_PUBLIC_KEYS as E2E_RELEASE_PUBLIC_KEYS } from "../e2e/release-keys.ts";

/**
 * The main-process bundle this desktop job is about to ship. The e2e keys are only for signing fixture manifests;
 * their presence here would let a fixture be installed as a trusted release. This check runs in release.yml before
 * electron-builder, even though a release job should never set the build-time key substitution.
 */
const bundle = process.argv[2];
if (bundle === undefined) throw new Error("usage: check-release-keys.ts <main bundle>");
const bytes = await Bun.file(bundle).text();
const leaked = E2E_RELEASE_PUBLIC_KEYS.filter((key) => bytes.includes(key));
if (leaked.length > 0) {
  console.error(
    `${bundle}: the desktop main bundle contains an e2e release public key. This bundle must not be shipped; build it without DORITERM_E2E_RELEASE_KEYS.`,
  );
  process.exit(1);
}
console.log(`${bundle}: no e2e release public key`);
