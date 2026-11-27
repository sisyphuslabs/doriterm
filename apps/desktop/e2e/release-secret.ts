/** The seed behind e2e/release-keys.ts, for specs that sign a fixture manifest; it signs nothing real. */
// Buffer, not Uint8Array.fromBase64: Playwright runs these specs under Node 24, which lacks it.
export const E2E_RELEASE_SECRET = new Uint8Array(Buffer.from("BAxrftgRl/pAp2e42ClLLMnmaRPuPJJLUZLJB1PdOi0=", "base64"));
