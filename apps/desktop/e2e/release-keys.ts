/**
 * The release keys of a desktop e2e build only: scripts/build.ts puts this module in place of
 * packages/crypto/src/release-keys.ts when DORITERM_E2E_RELEASE_KEYS=1, so the specs can sign a fixture herdr-core
 * manifest (E2E_RELEASE_SECRET). No shipped build carries it (test/release-keys.test.ts).
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = ["bzOnPxBx75BxSmFVw7jM5PDPYqqWaHvUnhXQWnAvjCc="];
