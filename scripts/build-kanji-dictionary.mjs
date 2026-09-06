// Regenerates src/data/kanji-dictionary.json from a jmdict-simplified "eng-common" release.
//
// Usage:
//   curl -sL -o jmdict.tgz "https://github.com/scriptin/jmdict-simplified/releases/download/<tag>/jmdict-eng-common-<version>.json.tgz"
//   tar xzf jmdict.tgz
//   node scripts/build-kanji-dictionary.mjs jmdict-eng-common-<version>.json
//
// Source data license: CC BY-SA 4.0 (JMdict/EDICT project, Electronic Dictionary
// Research and Development Group) — see README's "Kanji dictionary" section.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as wanakana from "wanakana";

const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error("Usage: node scripts/build-kanji-dictionary.mjs <jmdict-eng-common.json>");
  process.exit(1);
}

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outPath = join(projectRoot, "src/data/kanji-dictionary.json");

const raw = JSON.parse(readFileSync(sourcePath, "utf8"));

/** hiragana reading -> Map<kanjiText, { kanji, gloss, common }> */
const map = new Map();

for (const word of raw.words) {
  if (!word.kanji.length) continue;

  const firstSense = word.sense.find((s) => s.gloss.some((g) => g.lang === "eng"));
  if (!firstSense) continue;

  const gloss = firstSense.gloss
    .filter((g) => g.lang === "eng")
    .slice(0, 3)
    .map((g) => g.text)
    .join("; ");
  if (!gloss) continue;

  for (const kana of word.kana) {
    const reading = wanakana.toHiragana(kana.text);
    const appliesToAll =
      kana.appliesToKanji.length === 0 || kana.appliesToKanji.includes("*");
    const applicableKanji = appliesToAll
      ? word.kanji
      : word.kanji.filter((k) => kana.appliesToKanji.includes(k.text));

    for (const kanji of applicableKanji) {
      if (!map.has(reading)) map.set(reading, new Map());
      const candidates = map.get(reading);
      if (!candidates.has(kanji.text)) {
        candidates.set(kanji.text, {
          kanji: kanji.text,
          gloss,
          common: Boolean(kanji.common && kana.common),
        });
      }
    }
  }
}

// Array of [reading, candidates] tuples rather than a { [reading]: ... } object —
// a plain object with 17k+ literal keys makes TypeScript's JSON-module type
// inference (and `tsc`'s checking of it) balloon; an array has one uniform
// element type instead. Turned into a Map at runtime (see convert.tsx).
const entries = [...map].map(([reading, candidates]) => [
  reading,
  [...candidates.values()].sort((a, b) => Number(b.common) - Number(a.common)),
]);

const output = {
  source: "jmdict-simplified (jmdict-eng-common build)",
  version: raw.version,
  license:
    "CC BY-SA 4.0 — JMdict/EDICT project, Electronic Dictionary Research and Development Group",
  entries,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(output));

console.log(`Wrote ${Object.keys(entries).length} readings to ${outPath}`);
