// herdr-core's machine name rule (`check_name`), which every mesh name follows (design section 7.4).

const NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;
/** herdr refuses names shaped like its terminal ids: `t`, then 1-9, then only these characters. */
const ID_SHAPED = /^t[1-9][0123456789bcdfghjkmnpqrstvwxyz]*$/;

/** 1 to 32 of a-z, 0-9, `-`, `_` and `.`, starting with a letter or digit, and not id-shaped. */
export const isMeshName = (name: string): boolean => NAME.test(name) && !ID_SHAPED.test(name);

/**
 * The `mesh revoke` a reader offers for a member unreachable for more than 7 days. It is built here, never read from
 * the document, and only from a name herdr allows, so a rewritten document cannot put another command in front of
 * the owner: undefined for any other name.
 */
export const meshRevokeCommand = (name: string): string | undefined =>
  isMeshName(name) ? `doriface-host mesh revoke ${name}` : undefined;
