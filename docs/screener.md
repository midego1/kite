# Screener

The Screener asks you, the first time someone new writes to a mailbox, whether you want their mail. Until you decide, their messages wait outside the Inbox. You approve a sender once and everything they send afterwards arrives normally; you deny them and their mail goes to Spam. It works per mailbox and per sender address.

It needs database migration 0067. Until that migration is applied, every mailbox delivers as before, the Screener section in **Settings → Inbox** says the update is pending, and changing a setting or deciding on a sender answers `503 SCREENER_UNAVAILABLE`.

## Turning it on

The Screener is under **Settings → Inbox → Screener**, for the mailbox selected in the sidebar.

- **New mailboxes start with it on**, in Screener mode. Mailboxes that existed before migration 0067, mailboxes created before it was applied and the demo seed's mailboxes keep it off until you turn it on.
- The mode choice appears while the Screener is on. When you turn it on, Kite offers **Approve everyone you've written to** once. It approves every address this mailbox has sent mail to (To, Cc and Bcc, from the newest 5,000 sent messages) that you have not already approved or denied, and releases their waiting mail.
- When it is off, nothing is held and stored decisions are ignored. They are kept, so turning it back on restores them. Mail already waiting stays in the Screener until you decide on it or turn the Screener on again and approve it.

Only people with full access to the mailbox can change the settings or decide on senders. People with read-only access see the Screener view, the lists and the settings, but no buttons that change them; the API answers 403.

## The two modes

- **Hold in the Screener** (the default). Mail from new senders is held out of the Inbox and appears only under **Screener** in the sidebar, with a count of waiting messages. The Screener item appears only while the mailbox has the Screener on in this mode, or while mail is still waiting there.
- **Deliver to the Inbox**. Mail from new senders arrives in the Inbox as usual, with a **New sender** mark and **Approve** and **Deny** buttons in the row. Approving removes the mark from every message from that sender.

In both modes the reader shows a **New sender** bar above a waiting message with **Approve** and **Deny**.

## Approving and denying

- **Approve** releases every waiting message from that address to where it would have gone: the Inbox, or the folder a mailbox rule chose. The toast offers **Undo**, which forgets the approval and puts the released messages back in the Screener.
- **Deny** asks for confirmation, then moves the sender's waiting messages to Spam and trains the spam filter on them like **Report spam**. It also blocks the sender the same way **Report phishing** does (see [Spam protection](spam-protection.md#report-phishing)): a block rule for the mailbox, so later mail from that address is filed in **Trash** before the Screener sees it.
- **Settings → Inbox → Screener** lists approved and denied senders. **Remove** next to an approved sender forgets the approval, so their next message waits again. **Un-deny** lifts the block and forgets the denial, so their next message waits again instead of going to Trash. You can also add an approved address by hand.

Decisions are stored per mailbox for the lowercased address only, so approving `pat@example.com` does not approve the rest of `example.com`.

## Who is approved automatically

Sending from a mailbox approves every external To, Cc and Bcc address that has no decision yet, and releases their waiting mail. This install's own addresses are excluded. A denied address stays denied. Only mail you send counts, once it was delivered: an auto-reply (an `Auto-Submitted` header other than `no`) and mail a module sends for you, such as an invitation answer or a booking notice, approve nobody.

Mail claiming to come from this install's own mailboxes or aliases, or from system addresses (`mailer-daemon@`, `postmaster@`, `mail-daemon@`), still needs approval. The From header alone does not prove who sent it. The Screener is a sender preference, not a replacement for sender authentication or spam protection.

Saved contacts are not approved automatically; approve them once, or with **Approve everyone you've written to**.

## Where it sits in delivery

The spam filter and the mailbox's rules run first. The Screener only looks at mail they would still deliver to the Inbox or to a user folder; mail filed in Spam, Trash or Archive keeps its place. Held mail keeps the folder a rule chose and goes there when the sender is approved.

Mail that waits for a decision:

- gets no new-mail notification and no automatic reply;
- is not read automatically ([automatic reading](assistant.md)) until the sender is approved; approving schedules up to 25 of the released messages. Messages released because you wrote to the sender are not read automatically afterwards;
- still fires webhooks (`message.inbound`), because integrations may need every delivery (mail the spam filter, a rule or a denied sender files in Spam or Trash does not, see [Webhooks](api.md#webhooks));
- is not looked up on Gravatar when the sender first becomes a contact, so that contact gets no Gravatar picture ([Forged headers and sender names](spam-protection.md#forged-headers-and-sender-names)).

Held mail does not appear in the Inbox, folders, Starred, search, counts, conversations, bulk actions, JMAP, the `/api/v1` API or MCP. It appears only in the Screener view and its count. Inbox mode does not hold anything, so marked mail behaves like other Inbox mail.

## Backups

The settings (`screener_settings`) and decisions (`screener_senders`) are in database backups, in the "Mail and related data" group. A backup from before migration 0067 restores without them, and every mailbox then has the Screener off.

## API

The Screener is managed through the signed-in session API; it is not part of `/api/v1`.

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/screener?mailboxId=` | Settings, approved and denied senders, waiting count and whether you can manage them |
| `PATCH` | `/api/screener` | `{ mailboxId, enabled?, mode? }` with mode `screener` or `inbox` |
| `POST` | `/api/screener/senders` | `{ mailboxId, address, decision }` with decision `approved` or `denied` |
| `DELETE` | `/api/screener/senders` | `{ mailboxId, address, restoreMessageIds? }` forgets a decision; the ids put mail an approval released back |
| `POST` | `/api/screener/approve-sent` | Approve everyone the mailbox has written to |
| `GET` | `/api/screener/message?messageId=` | Whether the reader shows the New sender bar for a message |

Mailbox lists (`GET /api/mailboxes`) include each mailbox's `screener` settings, or `null` when it has none, and message lists mark waiting rows with `screenerPending: true`.
