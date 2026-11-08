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
| Connected account | Gekoppeld account | حساب مرتبط | The sidebar's "Connected accounts" section lists them as views of the Inbox. |
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
| Composer | Schrijfvenster | نافذة الكتابة | |
| Unsubscribe | Uitschrijven | إلغاء الاشتراك | Not "Afmelden", which is Sign out. |
| Booking, Bookings | Afspraken | الحجز، الحجوزات | One Dutch word for the module and its pages. |
| Mark as read, Mark as unread | Markeer als gelezen, Markeer als ongelezen | تعليم كمقروءة، تعليم كغير مقروءة | The same words on every mark action. |
| Good night | Goedenacht | مساء الخير | A greeting on arrival; the usual Arabic phrase is a goodbye. |
| Calendar | Agenda | التقويم | |
| Money (phone tab, short for Money Watch) | Geld | المال | Its accessible name stays Money Watch. |
| Sender, Recipient | Afzender, Ontvanger | مرسل، مستلم | |
| Phishing | Phishing | تصيد | |
| Not phishing | Geen phishing | ليست تصيدًا | The button that marks a flagged message as genuine and trusts its sender. |
| AI | AI | الذكاء الاصطناعي | |

## Arabic counts

A number with a noun depends on the number in Arabic, so anything with a count either uses a plural message with all six forms or a neutral label such as `المحدد: {count}` or `حذف المسودات ({count})؟`.
