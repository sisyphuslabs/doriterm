import { parseReleaseSecret } from "@doriface/crypto";

/** The seed behind e2e/release-keys.ts, for specs that sign a fixture manifest; it signs nothing real. */
export const E2E_RELEASE_SECRET = parseReleaseSecret("BAxrftgRl/pAp2e42ClLLMnmaRPuPJJLUZLJB1PdOi0=");
