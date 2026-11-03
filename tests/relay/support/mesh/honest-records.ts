import type { Step } from "./backdate-graphs.ts";
import type { SignedRecord } from "./status.ts";

interface Parsed {
  readonly hash: string;
  readonly type: string;
  readonly by: string;
  readonly prev: readonly string[];
  /** admit: the card's signPub. revoke: the revoked keys. name: the renamed key. */
  readonly about: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function aboutOf(subject: unknown): readonly string[] {
  if (!isRecord(subject)) return [];
  const card = subject["card"];
  if (isRecord(card) && typeof card["body"] === "string") {
    const body: unknown = JSON.parse(card["body"]);
    return isRecord(body) && typeof body["signPub"] === "string" ? [body["signPub"]] : [];
  }
  if (Array.isArray(subject["signPubs"])) return strings(subject["signPubs"]);
  return typeof subject["signPub"] === "string" ? [subject["signPub"]] : [];
}

/** A host's stored set, parsed far enough to find the records the design's honest steps name. */
export class StoredSet {
  readonly #byHash = new Map<string, Parsed>();

  constructor(records: readonly SignedRecord[], hashOf: (record: SignedRecord) => string) {
    for (const record of records) {
      const body: unknown = JSON.parse(record.body);
      if (!isRecord(body) || typeof body["type"] !== "string" || typeof body["by"] !== "string") continue;
      const hash = hashOf(record);
      this.#byHash.set(hash, {
        hash,
        type: body["type"],
        by: body["by"],
        prev: strings(body["prev"]),
        about: aboutOf(body["subject"]),
      });
    }
  }

  #past(hash: string): ReadonlySet<string> {
    const out = new Set<string>();
    const stack = [...(this.#byHash.get(hash)?.prev ?? [])];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      if (out.has(next)) continue;
      out.add(next);
      stack.push(...(this.#byHash.get(next)?.prev ?? []));
    }
    return out;
  }

  /**
   * The stored record a non-ack step stands for: same type, same signer, same subjects. `keyOf` maps the design's
   * keys (A, B, ...) to signPubs.
   */
  find(step: Step, keyOf: (key: string) => string): string | undefined {
    const about = step.type === "revoke" ? (step.subjects ?? []) : step.subject === undefined ? [] : [step.subject];
    const want = about.map(keyOf).toSorted().join(",");
    for (const parsed of this.#byHash.values()) {
      const sameAbout = step.type === "found" || [...parsed.about].toSorted().join(",") === want;
      if (parsed.type === step.type && parsed.by === keyOf(step.by) && sameAbout) return parsed.hash;
    }
    return undefined;
  }

  /** Whether `signPub` wrote an ack that has `after` in its past: the automatic ack of section 5.5. */
  ackedAfter(signPub: string, after: string): boolean {
    for (const parsed of this.#byHash.values()) {
      if (parsed.type === "ack" && parsed.by === signPub && this.#past(parsed.hash).has(after)) return true;
    }
    return false;
  }
}
