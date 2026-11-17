# Notes on conversations

A note is a short internal remark on a conversation, such as "Maya is a VIP, answer within the hour" or "Refund approved by Mo". Notes are useful in a shared mailbox, where several people answer the same mail: everyone with access to the mailbox sees them above the conversation. Notes are **never sent**. They are not part of any email, the people you write to never see them, and they do not show up in search. (Ported from upstream Mailflare #237.)

## Reading and writing notes

- **The Notes button** in the reader's toolbar (a sticky note) shows how many notes the open conversation has. Click it to show or hide the notes. When a conversation has notes they are shown when you open it.
- **The notes band** sits above the conversation. Each note shows who wrote it, when, and "(edited)" once its text changed. Notes are plain text; web and email addresses become links.
- **Adding a note.** Write in the box at the bottom of the band and choose **Add note**, or press Ctrl+Enter (⌘+Enter on a Mac). Tick **About this email only** to pin the note to the email you have open; the note then shows a chip naming that email ("About the email from Maya, 13 Nov, 10:42"), and clicking the chip scrolls to it. Without it the note is about the whole conversation. A note cannot be pinned to a draft (only its writer can open one), so the option is not offered there; a note written from a draft reply is about the conversation.
- **Editing and deleting.** Use the pencil to change a note you wrote (Escape cancels) and the bin to delete it. Deleting asks first.
- **One conversation, every email.** The notes belong to the conversation, so you see the same notes whichever of its emails you open, and a new reply arrives with them. A note written on an email before you sent it stays with the conversation once it is sent.
- **Limits.** A note can be up to 10,000 characters, and a conversation can hold up to 200 notes.
- **Changes by others** appear when new mail arrives or when you come back to the window after a minute or more; there is no need to reload.
- **Limits on changes.** Adding, editing and deleting notes is rate limited per person (the same allowance as the assistant's requests, about two a second); past it Kite asks you to try again in a minute.

## Who can do what

| Access to the mailbox                | Read notes | Add notes | Edit a note    | Delete a note |
| ------------------------------------ | ---------- | --------- | -------------- | ------------- |
| Owner, or shared with full access    | Yes        | Yes       | Their own      | Anyone's      |
| Send as, or send on behalf           | Yes        | Yes       | Their own      | Their own     |
| Read-only                            | Yes        | No        | No             | Their own     |
| No access                            | No         | No        | No             | No            |

- **Read-only means read-only.** Someone with read-only access to a shared mailbox reads every note but cannot add or edit one. The band tells them so. The one exception: someone whose access was lowered to read-only can still delete a note they wrote earlier, since taking back your own words changes nothing anyone else wrote.
- **Only the author edits.** Every note names who wrote it, so nobody else can change its text, an administrator or the mailbox's owner included. Someone with full access to the mailbox can delete any note, to keep a shared mailbox tidy.
- **Drafts stay private.** A draft is visible only to the person writing it, so notes written on a new draft are seen only by them until it is sent; a note written on a draft reply belongs to its conversation like any other.
- **Mail held by the Screener** shows its notes to people using Kite, but API keys and MCP clients do not see held mail or its notes, as everywhere else.
- **When an email or an account is deleted.** Deleting the email a note was pinned to keeps the note, about the whole conversation. Deleting a person's account keeps their notes, signed "Former member"; nobody can edit them any more, and someone with full access can delete them. Removing a mailbox deletes its notes. When the last email of a conversation is deleted for good (emptying Trash, the Trash retention, or deleting it), its notes are deleted with it, since nobody could reach them any more; moving mail to Trash keeps them.
- **Every change is recorded.** Adding, editing and deleting a note through Kite or the API writes a row to the audit log (who, which note, how; never the text), and deleting someone else's note names its author. MCP calls are recorded like every MCP tool call.

## API and MCP

- **REST, signed in:** `GET` and `POST /api/messages/{messageId}/notes`, `PATCH` and `DELETE /api/messages/{messageId}/notes/{noteId}`.
- **REST, with an API key:** the same under `/api/v1/messages/{id}/notes`. Listing needs the **Read mail** (`read`) scope; adding, editing and deleting need **Write notes** (`notes`), which you choose when creating the key in **Settings → API keys**. A key limited to some mailboxes reaches only their notes. See [API and integrations](api.md#notes-on-conversations).
- **MCP:** `list_conversation_notes` (**Read mail**), and `add_conversation_note`, `update_conversation_note` and `delete_conversation_note` (**Organize mail**). See [Email assistant and MCP](email-assistant-and-mcp.md).

The same rules apply everywhere: the key's user must be allowed to do it in Kite.

## Before the database update

Notes need database update 0115. Until an administrator applies it (Kite shows a banner in the mailbox), the reader shows no Notes button, listing answers an empty list with `migrationPending: true`, and adding, editing or deleting answers `409` with code `MIGRATION_PENDING`.

## Backups and privacy

Notes are stored in the `conversation_notes` table and are part of backups, in the **Mail and related data** group. See [Privacy](privacy.md#what-is-stored-where).
