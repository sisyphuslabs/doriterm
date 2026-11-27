import { door, type Signed } from "@doriface/mesh";

export class BundleRefused extends Error {
  override readonly name = "BundleRefused";
}

/** Adds every record the door admits on top of the held ones; one it refuses refuses the whole set. */
export function merge(held: readonly Signed[], incoming: readonly Signed[]): readonly Signed[] {
  const records = [...held];
  for (const record of incoming) {
    const verdict = door(record, records);
    if (!verdict.ok) {
      if (verdict.reason === "already stored") continue;
      throw new BundleRefused(`The mesh record was refused: ${verdict.reason}.`);
    }
    records.push(record);
  }
  return records;
}
