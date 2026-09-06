import { useEffect, useMemo, useState } from "react";
import {
  Action,
  ActionPanel,
  Clipboard,
  Icon,
  List,
  LocalStorage,
  closeMainWindow,
  getPreferenceValues,
  showHUD,
} from "@raycast/api";
import * as wanakana from "wanakana";
import kanjiDictionaryData from "./data/kanji-dictionary.json";

const HISTORY_KEY = "history";
const HISTORY_LIMIT = 10;
const JAPANESE_SCRIPT = /[぀-ヿ一-龯]/;

interface HistoryEntry {
  input: string;
  hiragana: string;
  katakana: string;
}

interface KanjiCandidate {
  kanji: string;
  gloss: string;
  common: boolean;
}

const kanjiDictionary = new Map<string, KanjiCandidate[]>(
  kanjiDictionaryData.entries as [string, KanjiCandidate[]][],
);

function normalizeRomaji(input: string): string {
  return input.replace(/tch/gi, "cch");
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

  const normalized = useMemo(() => normalizeRomaji(input), [input]);
  const hiragana = useMemo(
    () => wanakana.toHiragana(normalized, { IMEMode: true }),
    [normalized],
  );
  const katakana = useMemo(
    () => wanakana.toKatakana(normalized, { IMEMode: true }),
    [normalized],
  );
  const romaji = useMemo(
    () => (reverseMode ? wanakana.toRomaji(trimmed) : ""),
    [reverseMode, trimmed],
  );
  const readingForLookup = reverseMode
    ? wanakana.toHiragana(trimmed)
    : hiragana;
  const kanjiCandidates = useMemo(
    () => kanjiDictionary.get(readingForLookup) ?? [],
    [readingForLookup],
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
            await closeMainWindow();
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
    const sorted = [
      primaryAction,
      ...order.filter((kind) => kind !== primaryAction),
    ];
    return sorted.map((kind) => actionsByKind[kind]);
  }

  const currentEntry: HistoryEntry = reverseMode
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
                  recordHistory(currentEntry),
                )}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    );
  }

  const showHistory = keepHistory && input.length === 0 && history.length > 0;

  return (
    <List
      searchBarPlaceholder="Type Romaji, e.g. matcha — or paste kana for Romaji"
      searchText={input}
      onSearchTextChange={setInput}
      filtering={false}
    >
      {input.length === 0 ? (
        showHistory ? (
          <List.Section title="Recent">
            {history.map((entry) => (
              <List.Item
                key={entry.input}
                title={entry.hiragana}
                subtitle={`${entry.input} · Katakana ${entry.katakana}`}
                icon={Icon.Clock}
                actions={
                  <ActionPanel>
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
            title="Type Romaji to convert"
            description="Hiragana and Katakana results will appear here"
          />
        )
      ) : reverseMode ? (
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
        </>
      )}
    </List>
  );
}
