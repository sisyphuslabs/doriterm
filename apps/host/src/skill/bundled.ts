import { HOST_VERSION } from "../host-types.ts";
import type { SkillBundle } from "./agent-skill.ts";
import { readSkillSource } from "./bundle-macro.ts" with { type: "macro" };

/** The skill this host build carries: `skills/doriterm` as it was when the host was built, at the host's version. */
export const BUNDLED_SKILL: SkillBundle = { version: HOST_VERSION, files: readSkillSource() };
