import { useMemo, useState } from "react";
import {
  Action,
  ActionPanel,
  Clipboard,
  Icon,
  List,
  closeMainWindow,
  showHUD,
} from "@raycast/api";
import * as wanakana from "wanakana";

function normalizeRomaji(input: string): string {
  return input.replace(/tch/gi, "cch");
}

async function copyAndClose(value: string) {
  await Clipboard.copy(value);
  await closeMainWindow();
  await showHUD(`Copied "${value}"`);
}

export default function Command() {
  const [input, setInput] = useState("");

  const normalized = useMemo(() => normalizeRomaji(input), [input]);
  const hiragana = useMemo(
    () => wanakana.toHiragana(normalized, { IMEMode: true }),
    [normalized],
  );
  const katakana = useMemo(
    () => wanakana.toKatakana(normalized, { IMEMode: true }),
    [normalized],
  );

  return (
    <List
      searchBarPlaceholder="Type Romaji, e.g. matcha"
      searchText={input}
      onSearchTextChange={setInput}
      filtering={false}
    >
      {input.length === 0 ? (
        <List.EmptyView
          icon={Icon.Text}
          title="Type Romaji to convert"
          description="Hiragana and Katakana results will appear here"
        />
      ) : (
        <>
          <List.Item
            title={hiragana}
            subtitle="Hiragana"
            icon={Icon.Circle}
            actions={
              <ActionPanel>
                <Action
                  title="Copy Hiragana"
                  icon={Icon.Clipboard}
                  onAction={() => copyAndClose(hiragana)}
                />
                <Action.CopyToClipboard
                  title="Copy Hiragana (No Close)"
                  content={hiragana}
                />
              </ActionPanel>
            }
          />
          <List.Item
            title={katakana}
            subtitle="Katakana"
            icon={Icon.Circle}
            actions={
              <ActionPanel>
                <Action
                  title="Copy Katakana"
                  icon={Icon.Clipboard}
                  onAction={() => copyAndClose(katakana)}
                />
                <Action.CopyToClipboard
                  title="Copy Katakana (No Close)"
                  content={katakana}
                />
              </ActionPanel>
            }
          />
        </>
      )}
    </List>
  );
}
