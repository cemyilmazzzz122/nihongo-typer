import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { useEffect, useMemo, useState } from "react";
import {
  Action,
  ActionPanel,
  Clipboard,
  Icon,
  List,
  LocalStorage,
  Toast,
  getPreferenceValues,
  showHUD,
  showToast,
} from "@raycast/api";
import * as wanakana from "wanakana";
import kanjiDictionaryData from "./data/kanji-dictionary.json";
import englishIndexData from "./data/english-index.json";
import {
  JAPANESE_SCRIPT,
  KANJI_SCRIPT,
  toHiraganaFinal,
  toKatakanaFinal,
} from "./romaji";

const HISTORY_KEY = "history";
const FAVORITES_KEY = "favorites";
const HISTORY_LIMIT = 10;
const ENGLISH_MIN_WORD_LENGTH = 2;
const ENGLISH_MAX_RESULTS = 8;

interface HistoryEntry {
  input: string;
  hiragana: string;
  katakana: string;
  kanji?: string;
  gloss?: string;
}

interface KanjiCandidate {
  kanji: string;
  gloss: string;
  pos?: string;
  common: boolean;
}

interface ReadingCandidate {
  reading: string;
  gloss: string;
  pos?: string;
}

interface WordEntry {
  reading: string;
  kanji?: string;
  gloss: string;
  pos?: string;
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

// JMdict carries no JLPT levels, so the tag shown next to a dictionary result is
// its part of speech, which JMdict does have. Codes are expanded through the
// label table the build script emits alongside the entries.
const posLabels = new Map<string, string>(
  kanjiDictionaryData.posLabels as [string, string][],
);

function posTag(pos?: string): string | undefined {
  return pos ? (posLabels.get(pos) ?? pos) : undefined;
}

const execFileAsync = promisify(execFile);

// macOS ships Japanese voices (Kyoko/Otoya) that `say` can use offline, keeping
// the extension's no-network guarantee intact. They are optional downloads
// though, so a missing voice falls back to the system default rather than
// failing outright.
async function pronounce(text: string, voice: string) {
  try {
    await execFileAsync("say", voice ? ["-v", voice, text] : [text]);
  } catch {
    try {
      await execFileAsync("say", [text]);
    } catch {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not play pronunciation",
        message: `Install the ${voice || "Japanese"} voice in System Settings → Accessibility → Spoken Content`,
      });
    }
  }
}

function furiganaFormats(kanji: string, reading: string) {
  return [
    { title: "Furigana Text", content: `${kanji}(${reading})` },
    { title: "Anki / Markdown", content: `${kanji}[${reading}]` },
    { title: "HTML Ruby", content: `<ruby>${kanji}<rt>${reading}</rt></ruby>` },
  ];
}

function detailMarkdown(headline: string, reading?: string) {
  return reading && reading !== headline
    ? `# ${headline}\n\n## ${reading}`
    : `# ${headline}`;
}

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

async function loadFavorites(): Promise<HistoryEntry[]> {
  const raw = await LocalStorage.getItem<string>(FAVORITES_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as HistoryEntry[];
  } catch {
    return [];
  }
}

function saveFavorites(entries: HistoryEntry[]) {
  return LocalStorage.setItem(FAVORITES_KEY, JSON.stringify(entries));
}

// A saved word is identified by what the user would recognise it as — its Kanji
// when it has one, its reading otherwise — so the same word saved from the Kanji
// section and from a reverse lookup doesn't end up stored twice.
function favoriteKey(entry: HistoryEntry) {
  return entry.kanji ?? entry.hiragana;
}

export default function Command() {
  const { primaryAction, keepHistory, voice } =
    getPreferenceValues<Preferences.Convert>();

  const [input, setInput] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [favorites, setFavorites] = useState<HistoryEntry[]>([]);
  const [showingDetail, setShowingDetail] = useState(false);

  useEffect(() => {
    if (keepHistory) loadHistory().then(setHistory);
    loadFavorites().then(setFavorites);
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
  const hiragana = useMemo(() => toHiraganaFinal(trimmed), [trimmed]);
  const katakana = useMemo(() => toKatakanaFinal(trimmed), [trimmed]);
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

  function isFavorite(entry: HistoryEntry) {
    return favorites.some((item) => favoriteKey(item) === favoriteKey(entry));
  }

  function toggleFavorite(entry: HistoryEntry) {
    const key = favoriteKey(entry);
    const existing = favorites.some((item) => favoriteKey(item) === key);
    const next = existing
      ? favorites.filter((item) => favoriteKey(item) !== key)
      : [entry, ...favorites];
    setFavorites(next);
    saveFavorites(next);
    showToast({
      style: Toast.Style.Success,
      title: existing ? "Removed from Saved Words" : "Saved word",
    });
  }

  // Accessories and the detail pane are mutually exclusive in practice: Raycast
  // gives the list column very little room once the detail pane is open, so the
  // tag and star are dropped there and the same facts appear in the pane.
  function accessoriesFor(pos: string | undefined, entry: HistoryEntry) {
    if (showingDetail) return undefined;
    const accessories: List.Item.Accessory[] = [];
    if (isFavorite(entry)) accessories.push({ icon: Icon.Star });
    const tag = posTag(pos);
    if (tag) accessories.push({ tag });
    return accessories.length > 0 ? accessories : undefined;
  }

  function renderDetail(
    headline: string,
    reading?: string,
    meta?: { gloss?: string; pos?: string },
  ) {
    if (!showingDetail) return undefined;
    const romajiOf = reading ?? headline;
    return (
      <List.Item.Detail
        markdown={detailMarkdown(headline, reading)}
        metadata={
          <List.Item.Detail.Metadata>
            {reading && (
              <List.Item.Detail.Metadata.Label title="Reading" text={reading} />
            )}
            {wanakana.isJapanese(romajiOf) && (
              <List.Item.Detail.Metadata.Label
                title="Romaji"
                text={wanakana.toRomaji(romajiOf)}
              />
            )}
            {posTag(meta?.pos) && (
              <List.Item.Detail.Metadata.Label
                title="Part of Speech"
                text={posTag(meta?.pos)}
              />
            )}
            {meta?.gloss && (
              <List.Item.Detail.Metadata.Label
                title="Meaning"
                text={meta.gloss}
              />
            )}
          </List.Item.Detail.Metadata>
        }
      />
    );
  }

  // Every ActionPanel gets the same trailing section, so the shortcuts stay put
  // no matter which kind of result is selected. `speak` is the Japanese text to
  // pronounce, which is not always what the row copies (a Romaji row still has
  // to be spoken as kana).
  function renderExtras(options: {
    entry: HistoryEntry;
    speak?: string;
    kanji?: string;
    reading?: string;
  }) {
    const { entry, speak, kanji, reading } = options;
    const saved = isFavorite(entry);
    return (
      <ActionPanel.Section>
        {speak && (
          <Action
            title="Pronounce Word"
            icon={Icon.Speaker}
            shortcut={{ modifiers: ["cmd"], key: "p" }}
            onAction={() => pronounce(speak, voice)}
          />
        )}
        {kanji &&
          reading &&
          furiganaFormats(kanji, reading).map((format) => (
            <Action.CopyToClipboard
              key={format.title}
              title={`Copy ${format.title}`}
              icon={Icon.Text}
              content={format.content}
            />
          ))}
        <Action
          title={saved ? "Remove from Saved Words" : "Save to Saved Words"}
          icon={saved ? Icon.StarDisabled : Icon.Star}
          shortcut={{ modifiers: ["cmd"], key: "s" }}
          onAction={() => toggleFavorite(entry)}
        />
        <Action
          title="Toggle Details"
          icon={Icon.Sidebar}
          shortcut={{ modifiers: ["cmd"], key: "i" }}
          onAction={() => setShowingDetail((current) => !current)}
        />
      </ActionPanel.Section>
    );
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
        {kanjiCandidates.map((candidate) => {
          const entry: HistoryEntry = {
            ...currentEntry,
            kanji: candidate.kanji,
            gloss: candidate.gloss,
          };
          return (
            <List.Item
              key={candidate.kanji}
              title={candidate.kanji}
              subtitle={showingDetail ? undefined : candidate.gloss}
              icon={Icon.Book}
              accessories={accessoriesFor(candidate.pos, entry)}
              detail={renderDetail(candidate.kanji, readingForLookup, {
                gloss: candidate.gloss,
                pos: candidate.pos,
              })}
              actions={
                <ActionPanel>
                  {buildActions(candidate.kanji, "Kanji", () =>
                    recordHistory(entry),
                  )}
                  {renderExtras({
                    entry,
                    speak: candidate.kanji,
                    kanji: candidate.kanji,
                    reading: readingForLookup,
                  })}
                </ActionPanel>
              }
            />
          );
        })}
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
            gloss: result.gloss,
          };
          return (
            <List.Item
              key={`${result.reading}-${result.kanji ?? index}`}
              title={result.kanji ?? result.reading}
              subtitle={
                showingDetail
                  ? undefined
                  : result.kanji
                    ? `${result.reading} — ${result.gloss}`
                    : result.gloss
              }
              icon={Icon.MagnifyingGlass}
              accessories={accessoriesFor(result.pos, entry)}
              detail={renderDetail(
                result.kanji ?? result.reading,
                result.kanji ? result.reading : undefined,
                { gloss: result.gloss, pos: result.pos },
              )}
              actions={
                <ActionPanel>
                  {result.kanji &&
                    buildActions(result.kanji, "Kanji", () =>
                      recordHistory(entry),
                    )}
                  {buildActions(result.reading, readingLabel, () =>
                    recordHistory(entry),
                  )}
                  {renderExtras({
                    entry,
                    speak: result.kanji ?? result.reading,
                    kanji: result.kanji,
                    reading: result.reading,
                  })}
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    );
  }

  const showHistory = keepHistory && trimmed.length === 0 && history.length > 0;
  const showFavorites = trimmed.length === 0 && favorites.length > 0;

  function renderSavedSection() {
    if (!showFavorites) return null;
    return (
      <List.Section title="Saved Words">
        {favorites.map((entry) => (
          <List.Item
            key={`saved-${favoriteKey(entry)}`}
            title={entry.kanji ?? entry.hiragana}
            subtitle={
              showingDetail
                ? undefined
                : (entry.gloss ?? `${entry.hiragana} / ${entry.katakana}`)
            }
            icon={Icon.Star}
            detail={renderDetail(
              entry.kanji ?? entry.hiragana,
              entry.kanji ? entry.hiragana : undefined,
              { gloss: entry.gloss },
            )}
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
                {renderExtras({
                  entry,
                  speak: entry.kanji ?? entry.hiragana,
                  kanji: entry.kanji,
                  reading: entry.hiragana,
                })}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    );
  }

  return (
    <List
      searchBarPlaceholder="Type Romaji or English, e.g. matcha / bridge — or paste Kana/Kanji"
      searchText={input}
      onSearchTextChange={setInput}
      filtering={false}
      isShowingDetail={showingDetail}
    >
      {trimmed.length === 0 ? (
        showHistory || showFavorites ? (
          <>
            {renderSavedSection()}
            {showHistory && (
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
                        {renderExtras({
                          entry,
                          speak: entry.kanji ?? entry.hiragana,
                          kanji: entry.kanji,
                          reading: entry.hiragana,
                        })}
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
            )}
          </>
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
                gloss: candidate.gloss,
              };
              return (
                <List.Item
                  key={candidate.reading}
                  title={candidateRomaji}
                  subtitle={
                    showingDetail
                      ? undefined
                      : `Romaji · reading: ${candidate.reading} — ${candidate.gloss}`
                  }
                  icon={Icon.Circle}
                  accessories={accessoriesFor(candidate.pos, entry)}
                  detail={renderDetail(trimmed, candidate.reading, {
                    gloss: candidate.gloss,
                    pos: candidate.pos,
                  })}
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
                      {renderExtras({
                        entry,
                        speak: trimmed,
                        kanji: trimmed,
                        reading: candidate.reading,
                      })}
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
                {renderExtras({ entry: currentEntry, speak: trimmed })}
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
                  {renderExtras({ entry: currentEntry, speak: hiragana })}
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
                  {renderExtras({ entry: currentEntry, speak: katakana })}
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
                {renderExtras({ entry: currentEntry, speak: hiragana })}
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
                {renderExtras({ entry: currentEntry, speak: katakana })}
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
