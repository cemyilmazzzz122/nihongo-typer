# Nihongo Typer

A Raycast extension that converts Romaji into Hiragana and Katakana in real time — no need to switch your system keyboard layout to Japanese.

If you're learning Japanese, researching a trip, or looking up an authentic recipe, this lets you type a word the way you already type (Latin letters) and get both kana readings instantly, ready to paste anywhere.

## Command

### Convert Romaji to Kana

Open the command and start typing a word using Latin letters.

- The **Hiragana** reading is listed first (e.g. `matcha` → `まっちゃ`).
- The **Katakana** reading is listed right below it (e.g. `matcha` → `マッチャ`).
- Press <kbd>Enter</kbd> on either result to copy it to the clipboard and close Raycast.
- Use the secondary action (<kbd>⌘</kbd><kbd>Enter</kbd> from the action panel) to copy without closing the window, if you want to keep typing more words.

Both results update on every keystroke, so you can see the conversion build up character by character as you type.

## Conversion notes

- Conversion is powered by [wanakana](https://www.wanakana.com), the same rule set used by most browser-based Romaji-to-kana tools, so standard Hepburn spelling conventions apply (e.g. double consonants like `kk`, `ss`, `tt` produce the small `っ`/`ッ` sokuon, and `n` before `y` behaves as expected).
- As a convenience, `tch` is also treated as a sokuon trigger, so the common casual spelling `matcha` converts correctly instead of requiring the stricter `maccha`.
- Long vowels, youon (combined sounds like `kya`, `sha`, `cho`), and the particle-style `n` are all handled automatically.

## Privacy

All conversion happens entirely locally, in-process. No network requests are made and no text you type ever leaves your machine.

## Development

```bash
npm install
npm run dev     # run the extension locally in Raycast
npm run build   # type-check and build
npm run lint    # lint against Raycast's extension rules
```

## License

Licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE).
