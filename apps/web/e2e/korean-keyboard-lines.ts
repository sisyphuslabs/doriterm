import type { KoreanLine } from "./hangul-edits.ts";

/**
 * Lines typed on an iPhone's Korean keyboards, as the word shown in the field after each key (MODELS of the keyboards'
 * edits, built from the public iPhone traces named in hangul-edits.ts; no device recording). The 2-set keyboard names a
 * jamo a key; 천지인 (Cheonjiin) builds vowels from ㅣ, ㆍ and ㅡ, cycles a consonant key's letters (ㄴ, then ㄹ), and
 * shows a vowel stroke that joins nothing yet on its own (ㄷㆍ), so one key can take back two characters (입ㄹᆢ to 입려).
 */
export interface KoreanLineFixture {
  readonly name: string;
  readonly text: string;
  readonly keyboard: "2-set" | "cheonjiin";
  readonly line: KoreanLine;
}

export const KOREAN_LINES: readonly KoreanLineFixture[] = [
  {
    name: "a reported line",
    text: "한글로도 입력 잘 되니",
    keyboard: "2-set",
    line: [
      [
        ["ㅎ", "ㅎ"],
        ["ㅏ", "하"],
        ["ㄴ", "한"],
        ["ㄱ", "한ㄱ"],
        ["ㅡ", "한그"],
        ["ㄹ", "한글"],
        ["ㄹ", "한글ㄹ"],
        ["ㅗ", "한글로"],
        ["ㄷ", "한글롣"],
        ["ㅗ", "한글로도"],
      ],
      [
        ["ㅇ", "ㅇ"],
        ["ㅣ", "이"],
        ["ㅂ", "입"],
        ["ㄹ", "입ㄹ"],
        ["ㅕ", "입려"],
        ["ㄱ", "입력"],
      ],
      [
        ["ㅈ", "ㅈ"],
        ["ㅏ", "자"],
        ["ㄹ", "잘"],
      ],
      [
        ["ㄷ", "ㄷ"],
        ["ㅗ", "도"],
        ["ㅣ", "되"],
        ["ㄴ", "된"],
        ["ㅣ", "되니"],
      ],
    ],
  },
  {
    name: "a vowel-first word after a space",
    text: "가 아",
    keyboard: "2-set",
    line: [
      [
        ["ㄱ", "ㄱ"],
        ["ㅏ", "가"],
      ],
      [
        ["ㅇ", "ㅇ"],
        ["ㅏ", "아"],
      ],
    ],
  },
  {
    name: "a reported line",
    text: "입력 잘 되니",
    keyboard: "cheonjiin",
    line: [
      [
        ["ㅇ", "ㅇ"],
        ["ㅣ", "이"],
        ["ㅂ", "입"],
        ["ㄴ", "입ㄴ"],
        ["ㄹ", "입ㄹ"],
        ["ㆍ", "입ㄹㆍ"],
        ["ㆍ", "입ㄹᆢ"],
        ["ㅣ", "입려"],
        ["ㄱ", "입력"],
      ],
      [
        ["ㅈ", "ㅈ"],
        ["ㅣ", "지"],
        ["ㆍ", "자"],
        ["ㄴ", "잔"],
        ["ㄹ", "잘"],
      ],
      [
        ["ㄷ", "ㄷ"],
        ["ㆍ", "ㄷㆍ"],
        ["ㅡ", "도"],
        ["ㅣ", "되"],
        ["ㄴ", "된"],
        ["ㅣ", "되니"],
      ],
    ],
  },
  {
    name: "a vowel-first word after a space",
    text: "가 아",
    keyboard: "cheonjiin",
    line: [
      [
        ["ㄱ", "ㄱ"],
        ["ㅣ", "기"],
        ["ㆍ", "가"],
      ],
      [
        ["ㅇ", "ㅇ"],
        ["ㅣ", "이"],
        ["ㆍ", "아"],
      ],
    ],
  },
];
