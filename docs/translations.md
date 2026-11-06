# Translations

Kite's interface is available in English, Dutch and Arabic. Pick one under **Language** in the account menu. **Automatic** follows the browser's first language and falls back to English. The choice is saved to your account like the reading layout, unless this device keeps its own layout.

**Direction** on Automatic follows the interface language: Arabic reads right to left, the others left to right. An explicit Left to right or Right to left always wins.

Translated so far: the sidebar, the account menu, the message list, the reader's toolbar and menus, the composer and the panel shown when no message is open. Still English: Settings, Admin, the sign-in pages, the modules' own pages, the command palette, the keyboard shortcuts help, the assistant panel and error messages that come from the server. Someone whose browser is set to Arabic sees the sign-in pages mirrored, in English, until those pages are translated.

This setting changes Kite's own text. The mail you read is not translated by it, and nor is what you write: text that goes into a message, such as `Re:` or the line above a quote, stays as it was. Dates, numbers and sizes use the interface language; in English they keep following the browser's locale, as they always did.

The Arabic has not been reviewed by a native speaker yet. Corrections are welcome.

## How it works

The code lives in `src/lib/i18n/` and the catalogs in `src/locales/`, with the word choices in the [glossary](../src/locales/GLOSSARY.md).

- **Keys are the English text.** `t("Move to trash")` needs no key to invent and no English catalog, and a key a catalog lacks shows the English by itself. A catalog is a flat JSON object from that text to its translation.
- **Two meanings of one word** get a prefix that never shows: `t("folder|Archive")`.
- **Values and plurals** use a small part of ICU MessageFormat: `t("{count} unread in {folder}", { count, folder })` and `t("{count, plural, one {# attachment} other {# attachments}}", { count })`, where `#` is the number. `=0 {…}` matches an exact number. A number passed as a value is formatted for the language; a plural form comes from `Intl.PluralRules`, so an Arabic plural lists `zero`, `one`, `two`, `few`, `many` and `other`.
- **In a component** call `const t = useT()`, so a language change draws it again. **Helpers** called while rendering import `t` from `@/lib/i18n/translator`, and an effect that must not run again on a language change imports it `as translate`. **A table** outside a function marks its strings with `msg("…")` and whoever draws the entry calls `t(entry.label)`.
- **Dates and numbers** go through `currentLocale()`: `formatUserDate` already does.
- **Each language is a chunk** of its own, fetched with `import()`, so someone reading English downloads nothing extra. The mailbox waits for the first catalog rather than flash English.
- **The server always renders English** and hydration starts from it. The script in `<head>` sets `lang` and `dir` before the first paint and the catalog applies right after hydration, so the two cannot disagree. Pages that show translated text before sign-in would need the language on the server first.

Translate what people read, not what goes into mail or what the server stores: subjects, quoted headers and anything a person wrote stay as they are.

`tests/i18n.test.mjs` reads every `t()`, `translate()` and `msg()` call and fails on a key a catalog lacks, a catalog entry nothing uses, placeholders that differ from the source, or a plural without all the language's forms. A dynamic `t(variable)` is fine as long as the string is marked with `msg()` where it is written.

## Add a string

1. Wrap it: `t("Save changes")`.
2. Add it to `src/locales/nl.json` and `src/locales/ar.json`, and to the [glossary](../src/locales/GLOSSARY.md) if it is a new term.
3. `node --test tests/i18n.test.mjs`.

## Add a language

1. Copy `src/locales/nl.json` to `src/locales/<code>.json` and translate every value.
2. Add the code to `InterfaceLanguage` (`src/lib/i18n/i18n-types.d.ts`) and `LayoutInterfaceLanguage` (`src/lib/preferences/layout-types.d.ts`), the language with its own name to `INTERFACE_LANGUAGES` (`src/lib/i18n/language-utils.ts`), and a loader to `CATALOG_LOADERS` (`src/lib/i18n/catalogs.ts`).
3. Add the code to the list in `tests/i18n.test.mjs`. A right-to-left language is recognised by `isRtlLanguage` and mirrors on its own.
4. Add its column to the glossary, and say in this page whether a native speaker has reviewed it.
5. Run `node --test tests/i18n.test.mjs`, then try it in the account menu.
