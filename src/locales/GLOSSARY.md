# Glossary

Decisions for the interface translations, so one word stays one word everywhere. Add a line when you settle a new term. How the catalogs work is in [Translations](../../docs/translations.md).

The Arabic has not been reviewed by a native speaker yet; treat it as a first draft. Until it has been, Automatic never picks it: it is used only by someone who chooses العربية in the Language setting. After a review, set `automatic: true` for it in `INTERFACE_LANGUAGES` (`src/lib/i18n/language-utils.ts`) and update this note and [Translations](../../docs/translations.md).

## Product names

These are names, written in Latin letters in every language and never translated: **Kite**, **Screener**, **Drive**, **Money Watch**, **Gmail**, **iCloud**, **Cloudflare**, **R2**.

## Terms

| English | Nederlands | العربية | Note |
| --- | --- | --- | --- |
| Inbox | Inbox | البريد الوارد | The ordinary Dutch word, so not "Postvak IN". |
| Mailbox | Mailbox | صندوق البريد | |
| Starred | Met ster | المميّزة بنجمة | |
| Snooze, Snoozed | Uitstellen, Uitgesteld | تأجيل، المؤجّلة | A real verb rather than the anglicism. |
| Sent | Verzonden | المُرسَلة | |
| Draft, Drafts | Concept, Concepten | مسودة، المسودات | |
| Archive (verb) | Archiveren | أرشفة | Key `Archive`. |
| Archive (place) | Archief | الأرشيف | Key `folder\|Archive`. |
| Archive (file type) | Archiefbestand | ملف مضغوط | Key `file\|Archive`. All attachment type labels have the `file\|` prefix. |
| Archived | Gearchiveerd | المؤرشفة | |
| Spam | Spam | البريد العشوائي | |
| Trash | Prullenbak | سلة المهملات | |
| For you | Voor jou | لك | Informal, as all Dutch text is: *je*, never *u*. |
| Reply, Reply all | Beantwoorden, Allen beantwoorden | رد، الرد على الكل | |
| Forward | Doorsturen | إعادة توجيه | |
| Attachment | Bijlage | مرفق | |
| Composer | Opsteller | نافذة الكتابة | |
| Calendar | Agenda | التقويم | |
| Money (phone tab, short for Money Watch) | Geld | المال | Its accessible name stays Money Watch. |
| Sender, Recipient | Afzender, Ontvanger | مرسل، مستلم | |
| Phishing | Phishing | تصيد | |
| AI | AI | الذكاء الاصطناعي | |

## Arabic counts

A number with a noun depends on the number in Arabic, so anything with a count either uses a plural message with all six forms or a neutral label such as `المحدد: {count}` or `حذف المسودات ({count})؟`.
