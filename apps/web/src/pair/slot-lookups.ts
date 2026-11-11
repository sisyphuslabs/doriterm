import { codeCharacters, slotOf, typedSlot } from "./code.ts";
import type { PairingParse } from "./fragment.ts";
import { lookupSlot, offerFromSlot, type SlotAnswer } from "./lookup.ts";

type Lookup = (slot: string, relayUrl: string) => Promise<SlotAnswer>;

/**
 * Whether `text` can still be the start of a link typed by hand: `h`, `ht`, `htt`, `http` and `https` read as code
 * characters, so their slot is not asked for until a further character rules the link out (#1281).
 */
const linkPrefix = (text: string): boolean => {
  const typed = text.trim().toLowerCase();
  return ["http://", "https://"].some((scheme) => scheme.startsWith(typed));
};

interface Asked {
  readonly answer: Promise<SlotAnswer>;
  refused: boolean;
  /** Whether a Pair has taken this answer; a refusal is asked again only after a Pair has seen it. */
  offered: boolean;
}

/**
 * The relay's answer for the slot being typed. A slot is the code's first 3 characters, so its lookup starts as soon as
 * they are typed and runs while the other 5 are (#1271): the relay's first answer for a slot takes most of a second
 * from far away, and Pair then finds it waiting. Typing never spends the relay's budgets faster than Pair alone did:
 * only typing forward asks (an edit inside the slot would ask for shifted slots that belong to other people), each slot
 * is asked once and its answer kept, and nothing in flight is cancelled. Pair takes that answer whatever it says, a
 * refusal included, so a code the relay refused while typing costs one lookup until Pair is pressed again; that second
 * Pair, an explicit retry, asks once more, as a second Pair always did (#1316).
 */
export class SlotLookups {
  readonly #relayUrl: string;
  readonly #lookup: Lookup;
  readonly #asked = new Map<string, Asked>();
  #previous = "";

  constructor(relayUrl: string, lookup: Lookup = lookupSlot) {
    this.#relayUrl = relayUrl;
    this.#lookup = lookup;
  }

  /**
   * The code field now reads `text`: typed forward to a complete slot, that slot is looked up unless it already was or
   * the text can still become a link.
   */
  typed(text: string): void {
    const characters = codeCharacters(text);
    const forward = characters.startsWith(this.#previous);
    this.#previous = characters;
    const slot = typedSlot(text);
    if (forward && slot !== null && !linkPrefix(text) && !this.#asked.has(slot)) this.#ask(slot);
  }

  /** The offer for a whole code: its slot's answer, refusal included, or a new lookup once a Pair has seen that refusal. */
  async offer(code: string): Promise<PairingParse> {
    const slot = slotOf(code);
    const known = this.#asked.get(slot);
    // Typing's answer is the first Pair's answer even when it refused, so a refused code costs one lookup; a Pair after
    // that is an explicit retry and asks again, as a second Pair always did.
    const asked = known === undefined || (known.refused && known.offered) ? this.#ask(slot) : known;
    asked.offered = true;
    return offerFromSlot(await asked.answer, code, this.#relayUrl);
  }

  #ask(slot: string): Asked {
    const asked: Asked = { answer: this.#lookup(slot, this.#relayUrl), refused: false, offered: false };
    this.#asked.set(slot, asked);
    void asked.answer.then((settled) => {
      asked.refused = !settled.ok;
      return settled;
    });
    return asked;
  }
}
