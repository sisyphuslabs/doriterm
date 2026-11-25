/**
 * The oldest hc doriface works with: the protocol it speaks and every measured reply are hc 0.1.17's. The host checks
 * it before it installs or starts hc, and the client before it uses a core it reached (#651).
 */
export const HC_VERSION_FLOOR = "0.1.17";

/** The hc a host brings itself up to when it starts on an older one; `hc update` keeps every terminal running. */
export const HC_VERSION_RECOMMENDED = "0.1.22";

const numbers = (version: string): number[] =>
  version
    .replace(/^hc /, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);

/** Compares two `major.minor.patch` versions (a pre-release suffix is ignored): negative when `a` is older. */
export function compareHcVersions(a: string, b: string): number {
  const [left, right] = [numbers(a), numbers(b)];
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export const meetsHcFloor = (version: string): boolean => compareHcVersions(version, HC_VERSION_FLOOR) >= 0;
