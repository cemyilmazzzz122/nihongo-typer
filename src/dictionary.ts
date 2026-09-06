import * as wanakana from "wanakana";
import kanjiDictionaryData from "./data/kanji-dictionary.json";
import { KANJI_SCRIPT } from "./romaji";

export interface KanjiCandidate {
  kanji: string;
  gloss: string;
  pos?: string;
  common: boolean;
}

export interface ReadingCandidate {
  reading: string;
  gloss: string;
  pos?: string;
}

export const kanjiDictionary = new Map<string, KanjiCandidate[]>(
  kanjiDictionaryData.entries as [string, KanjiCandidate[]][],
);

// JMdict carries no JLPT levels, so the tag shown next to a dictionary result is
// its part of speech, which JMdict does have. Codes are expanded through the
// label table the build script emits alongside the entries.
const posLabels = new Map<string, string>(
  kanjiDictionaryData.posLabels as [string, string][],
);

export function posTag(pos?: string): string | undefined {
  return pos ? (posLabels.get(pos) ?? pos) : undefined;
}

// Reverse index (kanji spelling -> possible readings), built once from the same
// data: wanakana has no kanji-reading knowledge (that needs a morphological
// analyzer like MeCab/Kuromoji), so pasted Kanji can only be read back via an
// exact-match lookup against this bundled dictionary, not via wanakana.toRomaji.
// It is built lazily on the first Kanji lookup rather than at module load: inverting
// the whole dictionary is a 30k+ iteration pass that would otherwise run on every
// launch, including the common case where the user only ever types Romaji.
let kanjiToReadings: Map<string, ReadingCandidate[]> | undefined;

export function readingsForKanji(kanji: string): ReadingCandidate[] {
  if (!kanjiToReadings) {
    kanjiToReadings = new Map<string, ReadingCandidate[]>();
    for (const [reading, candidates] of kanjiDictionary) {
      for (const candidate of candidates) {
        let readings = kanjiToReadings.get(candidate.kanji);
        if (!readings) {
          readings = [];
          kanjiToReadings.set(candidate.kanji, readings);
        }
        readings.push({
          reading,
          gloss: candidate.gloss,
          pos: candidate.pos,
        });
      }
    }
  }
  return kanjiToReadings.get(kanji) ?? [];
}

// wanakana cannot read Kanji, so romanizing it directly either echoes the input
// back (猫 -> 猫) or, worse, half-converts it (食べる -> "食beru"). Kanji goes
// through the dictionary instead; `null` means "no known reading", which callers
// must report rather than pasting broken text.
export function romajiForJapanese(text: string): string | null {
  if (!KANJI_SCRIPT.test(text)) return wanakana.toRomaji(text);
  const readings = readingsForKanji(text);
  return readings.length > 0 ? wanakana.toRomaji(readings[0].reading) : null;
}
