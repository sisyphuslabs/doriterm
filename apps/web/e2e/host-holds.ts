/** What a hold from the host picks: frames containing this text, or frames this test function picks. */
export type Needle = string | ((frame: string) => boolean);

/** One holdFromHost: what it picks, and the frames it holds until its release delivers them. */
export interface HostHold {
  readonly needles: readonly Needle[];
  readonly parked: (() => void)[];
}

/** The first of these holds that picks the frame read as `text`, if any. */
export const holdOf = (holds: Iterable<HostHold>, text: string): HostHold | undefined =>
  [...holds].find((hold) =>
    hold.needles.some((needle) => (typeof needle === "string" ? text.includes(needle) : needle(text))),
  );
