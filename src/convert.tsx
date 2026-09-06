import { useEffect, useMemo, useState } from "react";
import {
  Action,
  ActionPanel,
  Clipboard,
  Icon,
  List,
  LocalStorage,
  getPreferenceValues,
  showHUD,
} from "@raycast/api";
import * as wanakana from "wanakana";
import kanjiDictionaryData from "./data/kanji-dictionary.json";
import englishIndexData from "./data/english-index.json";

const HISTORY_KEY = "history";
const HISTORY_LIMIT = 10;
const ENGLISH_MIN_WORD_LENGTH = 2;
const ENGLISH_MAX_RESULTS = 8;
const KANJI_SCRIPT = /[一-龯]/;
const JAPANESE_SCRIPT = /[぀-ヿ一-龯]/;

interface HistoryEntry {
  input: string;
  hiragana: string;
  katakana: string;
  kanji?: string;
}

interface KanjiCandidate {
  kanji: string;
  gloss: string;
  common: boolean;
}

interface ReadingCandidate {
  reading: string;
  gloss: string;
}

interface WordEntry {
  reading: string;
  kanji?: string;
  gloss: string;
}

const kanjiDictionary = new Map<string, KanjiCandidate[]>(
  kanjiDictionaryData.entries as [string, KanjiCandidate[]][],
);

// English -> Japanese search data: `words` is a deduped table of { reading,
// kanji?, gloss } entries, and `entries` maps an english gloss word to indices
// into that table — see scripts/build-kanji-dictionary.mjs for how both are
// derived from the same jmdict-simplified release as the kanji dictionary.
const englishWords = englishIndexData.words as WordEntry[];
const englishIndex = new Map<string, number[]>(
  englishIndexData.entries as [string, number[]][],
);
// Same list the index was built with, shipped in the data file rather than
// restated here so the two can't drift apart.
const englishStopwords = new Set(englishIndexData.stopwords as string[]);

function searchEnglish(query: string): WordEntry[] {
  // Stopwords are dropped rather than matched: they were never indexed, and
  // requiring them as a literal substring of the gloss is what made "cup of tea"
  // return nothing while "cup tea" worked (no gloss spells out "of").
  const words = query
    .toLowerCase()
    .split(/[^a-z']+/)
    .filter(
      (w) => w.length >= ENGLISH_MIN_WORD_LENGTH && !englishStopwords.has(w),
    );
  if (words.length === 0) return [];

  const indexed = words.filter((w) => englishIndex.has(w));
  if (indexed.length === 0) return [];

  // Anchor on the *most specific* word — the one with the fewest candidates —
  // rather than the first one. Each token keeps only its top
  // MAX_CANDIDATES_PER_TOKEN entries, so anchoring on a broad adjective like
  // "green" searches a truncated list that may not contain the compound the
  // user means, while its narrower partner ("tea") usually does.
  const bySpecificity = [...indexed].sort(
    (a, b) => englishIndex.get(a)!.length - englishIndex.get(b)!.length,
  );
  const [anchor, ...otherIndexed] = bySpecificity;
  const anchorIndices = englishIndex.get(anchor)!;

  // Prefer a real intersection of the per-word candidate sets; fall back to the
  // looser "anchor candidates whose gloss mentions the other words" when the
  // truncated lists don't overlap.
  const otherSets = otherIndexed.map((w) => new Set(englishIndex.get(w)!));
  const intersection = anchorIndices.filter((i) =>
    otherSets.every((set) => set.has(i)),
  );
  const matched = intersection.length > 0;

  // A word that is in no gloss at all can't be dropped like a stopword — it is
  // a real constraint the user typed, so it must still exclude everything.
  const unknown = words.filter((w) => !englishIndex.has(w));
  const glossFilters = matched ? unknown : [...otherIndexed, ...unknown];

  const candidates = (matched ? intersection : anchorIndices).map(
    (i) => englishWords[i],
  );
  const filtered =
    glossFilters.length === 0
      ? candidates
      : candidates.filter((c) =>
          glossFilters.every((w) => c.gloss.toLowerCase().includes(w)),
        );
  return filtered.slice(0, ENGLISH_MAX_RESULTS);
}

// Reverse index (kanji spelling -> possible readings), built once from the same
// data: wanakana has no kanji-reading knowledge (that needs a morphological
// analyzer like MeCab/Kuromoji), so pasted Kanji can only be read back via an
// exact-match lookup against this bundled dictionary, not via wanakana.toRomaji.
// It is built lazily on the first Kanji lookup rather than at module load: inverting
// the whole dictionary is a 30k+ iteration pass that would otherwise run on every
// launch, including the common case where the user only ever types Romaji.
let kanjiToReadings: Map<string, ReadingCandidate[]> | undefined;

function readingsForKanji(kanji: string): ReadingCandidate[] {
  if (!kanjiToReadings) {
    kanjiToReadings = new Map<string, ReadingCandidate[]>();
    for (const [reading, candidates] of kanjiDictionary) {
      for (const candidate of candidates) {
        let readings = kanjiToReadings.get(candidate.kanji);
        if (!readings) {
          readings = [];
          kanjiToReadings.set(candidate.kanji, readings);
        }
        readings.push({ reading, gloss: candidate.gloss });
      }
    }
  }
  return kanjiToReadings.get(kanji) ?? [];
}

function normalizeRomaji(input: string): string {
  // `tch` -> `cch` so casual spellings like "matcha" get the sokuon, and a
  // word-final `nn` -> `n` so the IME habit of typing "nihonn" still yields
  // にほん (plain wanakana would read that second n as its own syllable).
  return input.replace(/tch/gi, "cch").replace(/nn$/i, "n");
}

function toHiraganaFinal(input: string): string {
  return wanakana.toHiragana(input);
}

function toKatakanaFinal(input: string): string {
  return wanakana.toKatakana(input);
}

async function loadHistory(): Promise<HistoryEntry[]> {
  const raw = await LocalStorage.getItem<string>(HISTORY_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as HistoryEntry[];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]) {
  return LocalStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
}

export default function Command() {
  const { primaryAction, keepHistory } =
    getPreferenceValues<Preferences.Convert>();

  const [input, setInput] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    if (keepHistory) loadHistory().then(setHistory);
  }, [keepHistory]);

  const trimmed = input.trim();
  const reverseMode = trimmed.length > 0 && JAPANESE_SCRIPT.test(trimmed);
  const containsKanji = KANJI_SCRIPT.test(trimmed);
  // A pasted word can mix kanji and okurigana (e.g. 食べる) — wanakana can only
  // romanize the kana part, so a reading lookup is needed whenever any kanji
  // is present, not just for kanji-only input.
  const kanjiOnlyMode = reverseMode && containsKanji;
  const pureKanaMode = reverseMode && !containsKanji;

  // Conversion runs on the trimmed input: a trailing space would otherwise be
  // carried into the copied kana and, worse, into the dictionary lookup key,
  // where the exact match ("ねこ " vs "ねこ") drops every Kanji suggestion.
  const normalized = useMemo(() => normalizeRomaji(trimmed), [trimmed]);
  const hiragana = useMemo(() => toHiraganaFinal(normalized), [normalized]);
  const katakana = useMemo(() => toKatakanaFinal(normalized), [normalized]);
  const romaji = useMemo(
    () => (pureKanaMode ? wanakana.toRomaji(trimmed) : ""),
    [pureKanaMode, trimmed],
  );
  const readingForLookup = pureKanaMode
    ? wanakana.toHiragana(trimmed)
    : hiragana;
  const kanjiCandidates = useMemo(
    () => (kanjiOnlyMode ? [] : (kanjiDictionary.get(readingForLookup) ?? [])),
    [kanjiOnlyMode, readingForLookup],
  );
  const kanjiReadings = useMemo(
    () => (kanjiOnlyMode ? readingsForKanji(trimmed) : []),
    [kanjiOnlyMode, trimmed],
  );
  const englishResults = useMemo(
    () => (reverseMode ? [] : searchEnglish(trimmed)),
    [reverseMode, trimmed],
  );

  function recordHistory(entry: HistoryEntry) {
    if (!keepHistory) return;
    setHistory((current) => {
      const deduped = current.filter(
        (item) => item.input.toLowerCase() !== entry.input.toLowerCase(),
      );
      const next = [entry, ...deduped].slice(0, HISTORY_LIMIT);
      saveHistory(next);
      return next;
    });
  }

  function removeHistoryEntry(entryInput: string) {
    setHistory((current) => {
      const next = current.filter((item) => item.input !== entryInput);
      saveHistory(next);
      return next;
    });
  }

  function clearHistory() {
    setHistory([]);
    saveHistory([]);
  }

  function buildActions(kana: string, label: string, onUsed: () => void) {
    const actionsByKind = {
      copyAndClose: (
        <Action
          key="copyAndClose"
          title={`Copy ${label} and Close`}
          icon={Icon.Clipboard}
          onAction={async () => {
            await Clipboard.copy(kana);
            onUsed();
            await showHUD(`Copied "${kana}"`);
          }}
        />
      ),
      copyOnly: (
        <Action.CopyToClipboard
          key="copyOnly"
          title={`Copy ${label}`}
          content={kana}
          onCopy={onUsed}
        />
      ),
      paste: (
        <Action.Paste
          key="paste"
          title={`Paste ${label} to Active App`}
          content={kana}
          onPaste={onUsed}
        />
      ),
    };

    const order: (keyof typeof actionsByKind)[] = [
      "copyAndClose",
      "copyOnly",
      "paste",
    ];
    // Fall back rather than trusting the preference blindly: a missing or stale
    // stored value would otherwise put `undefined` at the head of the panel.
    const active = order.includes(primaryAction) ? primaryAction : order[0];
    const sorted = [active, ...order.filter((kind) => kind !== active)];
    return sorted.map((kind) => actionsByKind[kind]);
  }

  const currentEntry: HistoryEntry = pureKanaMode
    ? {
        input: trimmed,
        hiragana: readingForLookup,
        katakana: wanakana.toKatakana(readingForLookup),
      }
    : { input: trimmed, hiragana, katakana };

  function renderKanjiSection() {
    if (kanjiCandidates.length === 0) return null;
    return (
      <List.Section title="Kanji">
        {kanjiCandidates.map((candidate) => (
          <List.Item
            key={candidate.kanji}
            title={candidate.kanji}
            subtitle={candidate.gloss}
            icon={Icon.Book}
            actions={
              <ActionPanel>
                {buildActions(candidate.kanji, "Kanji", () =>
                  recordHistory({ ...currentEntry, kanji: candidate.kanji }),
                )}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    );
  }

  function renderEnglishSection() {
    if (englishResults.length === 0) return null;
    return (
      <List.Section title="English → Japanese">
        {englishResults.map((result, index) => {
          // The index stores each reading in its native script (loanwords stay
          // Katakana), so label the action after what the reading actually is.
          const readingLabel = wanakana.isKatakana(result.reading)
            ? "Katakana"
            : "Hiragana";
          const entry: HistoryEntry = {
            input: trimmed,
            hiragana: wanakana.toHiragana(result.reading),
            katakana: wanakana.toKatakana(result.reading),
            kanji: result.kanji,
          };
          return (
            <List.Item
              key={`${result.reading}-${result.kanji ?? index}`}
              title={result.kanji ?? result.reading}
              subtitle={
                result.kanji
                  ? `${result.reading} — ${result.gloss}`
                  : result.gloss
              }
              icon={Icon.MagnifyingGlass}
              actions={
                <ActionPanel>
                  {result.kanji &&
                    buildActions(result.kanji, "Kanji", () =>
                      recordHistory(entry),
                    )}
                  {buildActions(result.reading, readingLabel, () =>
                    recordHistory(entry),
                  )}
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    );
  }

  const showHistory = keepHistory && trimmed.length === 0 && history.length > 0;

  return (
    <List
      searchBarPlaceholder="Type Romaji or English, e.g. matcha / bridge — or paste Kana/Kanji"
      searchText={input}
      onSearchTextChange={setInput}
      filtering={false}
    >
      {trimmed.length === 0 ? (
        showHistory ? (
          <List.Section title="Recent">
            {history.map((entry) => (
              <List.Item
                key={entry.input}
                title={entry.kanji ?? entry.hiragana}
                subtitle={
                  entry.kanji
                    ? `${entry.input} · ${entry.hiragana} / ${entry.katakana}`
                    : `${entry.input} · Katakana ${entry.katakana}`
                }
                icon={entry.kanji ? Icon.Book : Icon.Clock}
                actions={
                  <ActionPanel>
                    {entry.kanji &&
                      buildActions(entry.kanji, "Kanji", () =>
                        recordHistory(entry),
                      )}
                    {buildActions(entry.hiragana, "Hiragana", () =>
                      recordHistory(entry),
                    )}
                    {buildActions(entry.katakana, "Katakana", () =>
                      recordHistory(entry),
                    )}
                    <Action
                      title="Remove from History"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={{ modifiers: ["ctrl"], key: "x" }}
                      onAction={() => removeHistoryEntry(entry.input)}
                    />
                    <Action
                      title="Clear History"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={{ modifiers: ["ctrl", "shift"], key: "x" }}
                      onAction={clearHistory}
                    />
                  </ActionPanel>
                }
              />
            ))}
          </List.Section>
        ) : (
          <List.EmptyView
            icon={Icon.Text}
            title="Type Romaji or English to search"
            description="Hiragana, Katakana, Kanji, and English lookup results will appear here"
          />
        )
      ) : kanjiOnlyMode ? (
        kanjiReadings.length > 0 ? (
          <List.Section title="Readings">
            {kanjiReadings.map((candidate) => {
              const candidateRomaji = wanakana.toRomaji(candidate.reading);
              const entry: HistoryEntry = {
                input: trimmed,
                hiragana: candidate.reading,
                katakana: wanakana.toKatakana(candidate.reading),
                kanji: trimmed,
              };
              return (
                <List.Item
                  key={candidate.reading}
                  title={candidateRomaji}
                  subtitle={`Romaji · reading: ${candidate.reading} — ${candidate.gloss}`}
                  icon={Icon.Circle}
                  actions={
                    <ActionPanel>
                      {buildActions(candidateRomaji, "Romaji", () =>
                        recordHistory(entry),
                      )}
                      {/* Someone pasting Kanji usually wants its kana reading
                          at least as often as the Romaji, so offer both. */}
                      {buildActions(candidate.reading, "Hiragana", () =>
                        recordHistory(entry),
                      )}
                      {buildActions(entry.katakana, "Katakana", () =>
                        recordHistory(entry),
                      )}
                    </ActionPanel>
                  }
                />
              );
            })}
          </List.Section>
        ) : (
          <List.EmptyView
            icon={Icon.QuestionMarkCircle}
            title="No known reading for this Kanji"
            description="This word isn't in the bundled dictionary, so Romaji can't be generated for it."
          />
        )
      ) : pureKanaMode ? (
        <>
          <List.Item
            title={romaji}
            subtitle="Romaji"
            icon={Icon.Circle}
            actions={
              <ActionPanel>
                {buildActions(romaji, "Romaji", () =>
                  recordHistory(currentEntry),
                )}
              </ActionPanel>
            }
          />
          {/* Kana-to-kana: show whichever script the input isn't already in,
              so pasted ねこ also offers ネコ (and コーヒー offers こうひい). */}
          {hiragana !== trimmed && (
            <List.Item
              title={hiragana}
              subtitle="Hiragana"
              icon={Icon.Circle}
              actions={
                <ActionPanel>
                  {buildActions(hiragana, "Hiragana", () =>
                    recordHistory(currentEntry),
                  )}
                </ActionPanel>
              }
            />
          )}
          {katakana !== trimmed && (
            <List.Item
              title={katakana}
              subtitle="Katakana"
              icon={Icon.Circle}
              actions={
                <ActionPanel>
                  {buildActions(katakana, "Katakana", () =>
                    recordHistory(currentEntry),
                  )}
                </ActionPanel>
              }
            />
          )}
          {renderKanjiSection()}
        </>
      ) : (
        <>
          <List.Item
            title={hiragana}
            subtitle="Hiragana"
            icon={Icon.Circle}
            actions={
              <ActionPanel>
                {buildActions(hiragana, "Hiragana", () =>
                  recordHistory(currentEntry),
                )}
              </ActionPanel>
            }
          />
          <List.Item
            title={katakana}
            subtitle="Katakana"
            icon={Icon.Circle}
            actions={
              <ActionPanel>
                {buildActions(katakana, "Katakana", () =>
                  recordHistory(currentEntry),
                )}
              </ActionPanel>
            }
          />
          {renderKanjiSection()}
          {renderEnglishSection()}
        </>
      )}
    </List>
  );
}
