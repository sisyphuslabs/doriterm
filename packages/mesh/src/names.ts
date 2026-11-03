// herdr-core's machine-name rule (`addr.rs` `check_name`, `terminals.rs` `id_shaped`) and the mesh fallback names.

const ID_SYMBOLS = /^[0123456789bcdfghjkmnpqrstvwxyz]*$/;

/** `t`, then 1-9, then only id symbols: herdr reserves these for terminal ids. */
export const idShaped = (name: string): boolean => /^t[1-9]/.test(name) && ID_SYMBOLS.test(name.slice(1));

/** 1 to 32 of `a-z 0-9 - _ .`, starting with a letter or digit, and not id-shaped. */
export const checkName = (name: string): boolean => /^[a-z0-9][a-z0-9._-]{0,31}$/.test(name) && !idShaped(name);

export const FALLBACK_LENGTHS = [4, 8, 12] as const;

/** `<name cut to 31-k>-<first k hostId characters>` for k = 4, 8, 12, in order. */
export const fallbacks = (name: string, hostId: string): readonly string[] =>
  FALLBACK_LENGTHS.map((k) => `${name.slice(0, 31 - k)}-${hostId.slice(0, k)}`);
