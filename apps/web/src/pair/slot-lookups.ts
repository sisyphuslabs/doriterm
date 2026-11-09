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
}

/**
 * The relay's answer for the slot being typed. A slot is the code's first 3 characters, so its lookup starts as soon as
 * they are typed and runs while the other 5 are (#1271): the relay's first answer for a slot takes most of a second
 * from far away, and Pair then finds it waiting. Typing never spends the relay's budgets faster than Pair alone did:
 * only typing forward asks (an edit inside the slot would ask for shifted slots that belong to other people), each slot
 * is asked once and its answer kept, nothing in flight is cancelled, and only Pair asks a refused slot again, as a
 * second Pair always did.
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

  /** The offer for a whole code, from its slot's answer when one was asked for and did not refuse, else from a new one. */
  async offer(code: string): Promise<PairingParse> {
    const slot = slotOf(code);
    const known = this.#asked.get(slot);
    const answer = known === undefined || known.refused ? this.#ask(slot) : known.answer;
    return offerFromSlot(await answer, code, this.#relayUrl);
  }

  #ask(slot: string): Promise<SlotAnswer> {
    const asked: Asked = { answer: this.#lookup(slot, this.#relayUrl), refused: false };
    this.#asked.set(slot, asked);
    void asked.answer.then((settled) => {
      asked.refused = !settled.ok;
      return settled;
    });
    return asked.answer;
  }
}
