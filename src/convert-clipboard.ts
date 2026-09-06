import { Clipboard, getPreferenceValues, showHUD } from "@raycast/api";
import { JAPANESE_SCRIPT, toHiraganaFinal, toKatakanaFinal } from "./romaji";
import { romajiForJapanese } from "./dictionary";

export default async function Command() {
  const { clipboardTarget } =
    getPreferenceValues<Preferences.ConvertClipboard>();

  const text = (await Clipboard.readText())?.trim();
  if (!text) {
    await showHUD("Clipboard is empty");
    return;
  }

  // Mirrors the view command's two directions: Japanese in the clipboard comes
  // back as Romaji, anything else is treated as Romaji to convert.
  const reverse = JAPANESE_SCRIPT.test(text);
  const converted = reverse
    ? romajiForJapanese(text)
    : clipboardTarget === "katakana"
      ? toKatakanaFinal(text)
      : toHiraganaFinal(text);

  if (converted === null) {
    await showHUD(`No known reading for "${text}"`);
    return;
  }
  if (converted === text) {
    await showHUD("Nothing to convert");
    return;
  }

  await Clipboard.paste(converted);
  const label = reverse
    ? "Romaji"
    : clipboardTarget === "katakana"
      ? "Katakana"
      : "Hiragana";
  await showHUD(`Converted to ${label}`);
}
