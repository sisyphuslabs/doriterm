/** The keystroke latency matrix's link round trips and prediction modes (keystroke-latency-relay.e2e.ts). */
export const LATENCY_RTTS = [0, 150, 300] as const;
export const LATENCY_MODES = ["never", "adaptive"] as const;

/**
 * The tag that moves a case to the nightly relay job (relay-nightly.yml); pull requests run the rest (#2028). The rtt
 * 150 row sits between the two a pull request keeps, rtt 0 (the base cost) and rtt 300 (prediction on a slow link).
 */
export const NIGHTLY_TAG = "@nightly";

export function latencyCaseTitle(rtt: (typeof LATENCY_RTTS)[number], mode: (typeof LATENCY_MODES)[number]): string {
  const title = `over the relay at rtt ${rtt} ms, predictions ${mode}: keystroke-to-glyph and to-echo latency`;
  return rtt === 150 ? `${title} ${NIGHTLY_TAG}` : title;
}
